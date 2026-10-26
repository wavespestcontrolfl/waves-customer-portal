const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { noStore } = require('../middleware/no-store');

// Customer documents + the public /shared/:token surface: personal and
// financial paperwork — never cacheable, never indexable.
router.use(noStore);
const db = require('../models/db');
const { projectReportPathForProject } = require('../services/project-report-links');
const {
  getProjectType,
  redactInspectionFeeCuesForType,
  redactSpecificAmounts,
  projectRecordedFeeValues,
  projectTypeHasInternalFindingKeys,
} = require('../services/project-types');
const { authenticate } = require('../middleware/auth');
const { customerSafeVisitNotes } = require('../services/context-aggregator');
const logger = require('../services/logger');
const { formatAddress } = require('../utils/address-normalizer');
const { applyReportIdentitySnapshotToLegacyPdf, readReportIdentitySnapshot } = require('../services/service-report/report-identity-snapshot');
const { applyCustomerVisibleServiceRecordFilter } = require('../services/pest-pressure/history-filter');
const {
  WAVES_ADDRESS_LINE,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_PRODUCTS_SAFETY_URL,
} = require('../constants/business');
const PhotoService = require('../services/photos');

// =========================================================================
// PDF GENERATION — builds a branded service report
// =========================================================================
// Waves brand colors
const NAVY = '#1B2C5B';
const TEAL = '#009CDE';
const GREEN = '#10b981';
const RED = '#A83B34';
const LIGHT_BG = '#F8FCFE';
const BODY = '#3F4A65';
const MUTED_ON_DARK = '#B8D4EA';
const MUTED = '#6B7280';

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

async function getServiceReportCredentialText() {
  try {
    const row = await db('business_credentials')
      .where({ slug: 'fdacs_pest_control', is_public: true, status: 'active' })
      .whereNull('archived_at')
      .first('display_format_short');
    return row?.display_format_short
      ? `Licensed & Insured | FL ${row.display_format_short}`
      : 'Licensed & Insured';
  } catch (err) {
    logger.warn(`[documents] credential lookup failed: ${err.message}`);
    return 'Licensed & Insured';
  }
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
  return 'Keep people and pets off treated areas until completely dry — your technician confirms timing for the products used. Minor pest activity may continue 7-14 days as product takes full effect.';
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

function generateServiceReportPDF(customer, service, products, res, extra = {}) {
  // withholdPlan (a CONTACT's own download, contact-session-projection.js
  // contactSafeReportCustomer): the holder's plan stays off the page — the
  // callback callout names the WaveGuard membership, so it goes too
  // (codex #6363 r13 P2).
  const { compliance = [], invoice = null, withholdPlan = false } = extra;
  const credentialText = extra.credentialText || 'Licensed & Insured';
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });

  // Build filename: firstName-lastName-YYYY-MM-DD.pdf (sanitized to prevent
  // header injection / path traversal via customer-controlled name fields).
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'customer';
  const svcDate = new Date(typeof service.service_date === 'string' ? service.service_date + 'T12:00:00' : service.service_date);
  const dateStr = `${svcDate.getFullYear()}-${String(svcDate.getMonth() + 1).padStart(2, '0')}-${String(svcDate.getDate()).padStart(2, '0')}`;
  const fileName = `${safe(customer.first_name)}-${safe(customer.last_name)}-${dateStr}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  doc.pipe(res);

  const L = 40, R = 572, W = R - L;
  const customerName = `${customer.first_name} ${customer.last_name}`;
  const visitDuration = getVisitDuration(service);
  const isCallback = service.is_callback || (service.service_type && service.service_type.toLowerCase().includes('callback'));
  // An included rodent trap check is a callback of the trapping job, not of
  // a WaveGuard membership (owner ruling 2026-09-26: $350 trapping covers
  // setup + 1 check; the paid $95 check is never a callback).
  const isIncludedTrapCheck = isCallback && /\btrap/i.test(String(service.service_type || ''));

  // Parse weather data
  let weather = null;
  for (const field of ['weather_data', 'weather_at_service']) {
    if (service[field]) {
      try { weather = typeof service[field] === 'string' ? JSON.parse(service[field]) : service[field]; } catch { /* ignore */ }
      if (weather) break;
    }
  }

  // Parse structured notes / AI report
  let structuredNotes = null;
  if (service.structured_notes) {
    try { structuredNotes = typeof service.structured_notes === 'string' ? JSON.parse(service.structured_notes) : service.structured_notes; } catch { /* ignore */ }
  }
  let aiReport = null;
  if (service.ai_report) {
    try { aiReport = typeof service.ai_report === 'string' ? JSON.parse(service.ai_report) : service.ai_report; } catch { /* ignore */ }
  }

  // Parse areas serviced
  let areasServiced = null;
  if (service.areas_serviced) {
    try { areasServiced = typeof service.areas_serviced === 'string' ? JSON.parse(service.areas_serviced) : service.areas_serviced; } catch { /* ignore */ }
  }

  // Interior serviced flag
  const interiorServiced = service.customer_interaction === 'interior' ||
    (areasServiced && (areasServiced.interior === true || (Array.isArray(areasServiced) && areasServiced.some(a => /interior/i.test(a)))));

  // Build compliance lookup by product name
  const complianceByProduct = {};
  compliance.forEach(c => {
    if (c.product_id) complianceByProduct[c.product_id] = c;
  });

  // ══════════════════════════════════════════════════════
  // HEADER BAR
  // ══════════════════════════════════════════════════════
  doc.save();
  doc.rect(0, 0, 612, 80).fill(NAVY);

  // Logo (left). Header bar is 80px tall; render at 64px with ~8px
  // padding top/bottom. Fall back to the wordmark if the asset is
  // missing so the PDF never breaks in production.
  const { getLogoBuffer } = require('../services/pdf/brand-logo');
  const logoBuf = getLogoBuffer();
  if (logoBuf) {
    doc.image(logoBuf, L + 2, 8, { width: 64, height: 64 });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED_ON_DARK).text(credentialText, L + 72, 60);
  } else {
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('WAVES', L + 10, 18);
    doc.fontSize(9).font('Helvetica').fillColor(TEAL).text('LAWN & PEST CONTROL', L + 10, 42);
    doc.fontSize(8).fillColor(MUTED_ON_DARK).text(credentialText, L + 10, 56);
  }

  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(WAVES_SUPPORT_PHONE_DISPLAY, R - 150, 22, { width: 150, align: 'right' });
  doc.fontSize(8).font('Helvetica').fillColor(MUTED_ON_DARK).text('wavespestcontrol.com', R - 150, 36, { width: 150, align: 'right' });
  doc.text('Bradenton, FL 34211', R - 150, 48, { width: 150, align: 'right' });
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
  y = infoRow(doc, 'City:', formatAddress({ city: customer.city, state: customer.state || 'FL', zip: customer.zip }), L + 8, y, 70, 180);
  y = infoRow(doc, 'Phone:', customer.phone || '', L + 8, y, 70, 180);
  if (customer.email) y = infoRow(doc, 'Email:', customer.email, L + 8, y, 70, 180);

  // Right column — Service
  let y2 = 130;
  y2 = sectionHeader(doc, 'Service Information', colMid, y2);
  y2 = infoRow(doc, 'Date:', formatDate(service.service_date), colMid + 8, y2, 80, 170);
  y2 = infoRow(doc, 'Service:', service.service_type, colMid + 8, y2, 80, 170);
  y2 = infoRow(doc, 'Technician:', service.technician_name || 'Waves Team', colMid + 8, y2, 80, 170);
  if (service.technician_license) {
    y2 = infoRow(doc, 'License #:', service.technician_license, colMid + 8, y2, 80, 170);
  }
  // Time in / time out
  if (service.check_in_time) {
    const inTime = new Date(service.check_in_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    const outTime = service.check_out_time ? new Date(service.check_out_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—';
    y2 = infoRow(doc, 'Time In/Out:', `${inTime} — ${outTime}`, colMid + 8, y2, 80, 170);
  }
  if (visitDuration) {
    y2 = infoRow(doc, 'Time on site:', `${visitDuration} minutes`, colMid + 8, y2, 80, 170);
  }
  if (customer.waveguard_tier) {
    y2 = infoRow(doc, 'Plan:', `WaveGuard ${customer.waveguard_tier}`, colMid + 8, y2, 80, 170);
  }
  // Interior / Exterior flag
  const serviceScope = interiorServiced ? 'Interior & Exterior' : 'Exterior Only';
  y2 = infoRow(doc, 'Serviced:', serviceScope, colMid + 8, y2, 80, 170);

  y = Math.max(y, y2) + 12;

  // ══════════════════════════════════════════════════════
  // PROPERTY SNAPSHOT + ENVIRONMENTAL CONDITIONS
  // ══════════════════════════════════════════════════════
  const snapshotItems = [];
  if (customer.lawn_type) snapshotItems.push({ label: 'Lawn Type', value: customer.lawn_type });
  if (customer.property_sqft) snapshotItems.push({ label: 'Property Size', value: `${Number(customer.property_sqft).toLocaleString()} sq ft` });
  // Treated area from compliance records
  const totalTreated = compliance.reduce((s, c) => s + (c.area_treated_sqft || 0), 0);
  if (totalTreated > 0) snapshotItems.push({ label: 'Area Treated', value: `${Number(totalTreated).toLocaleString()} sq ft` });
  if (customer.waveguard_tier) snapshotItems.push({ label: 'WaveGuard', value: customer.waveguard_tier });
  if (visitDuration) snapshotItems.push({ label: 'Duration', value: `${visitDuration} min` });

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

  // Environmental conditions bar
  const envItems = [];
  if (weather) {
    if (weather.temp) envItems.push({ label: 'Temperature', value: typeof weather.temp === 'number' ? `${weather.temp}°F` : weather.temp });
    if (weather.wind) envItems.push({ label: 'Wind', value: weather.wind });
    if (weather.humidity) envItems.push({ label: 'Humidity', value: typeof weather.humidity === 'number' ? `${weather.humidity}%` : weather.humidity });
    if (weather.cloudCover) envItems.push({ label: 'Cloud Cover', value: typeof weather.cloudCover === 'number' ? `${weather.cloudCover}%` : weather.cloudCover });
  }
  // Soil readings from service record
  if (service.soil_temp) envItems.push({ label: 'Soil Temp', value: `${service.soil_temp}°F` });

  if (envItems.length) {
    y = sectionHeader(doc, 'Conditions at Time of Service', L, y);
    doc.save();
    doc.roundedRect(L, y, W, 24, 3).fill('#E8F5E9');
    const envColW = W / envItems.length;
    envItems.forEach((item, i) => {
      const xPos = L + i * envColW + 12;
      doc.fontSize(7).font('Helvetica').fillColor('#555').text(item.label, xPos, y + 3, { width: envColW - 20 });
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#2E7D32').text(item.value, xPos, y + 13, { width: envColW - 20 });
    });
    doc.restore();
    y += 34;
  }

  // ══════════════════════════════════════════════════════
  // WAVEGUARD CALLBACK CALLOUT
  // ══════════════════════════════════════════════════════
  if (isCallback && !withholdPlan) {
    if (y > 680) { doc.addPage(); y = 50; }
    doc.save();
    doc.roundedRect(L, y, W, 30, 4).fill('#E8F5E9');
    doc.roundedRect(L, y, 4, 30, 2).fill(GREEN);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#2E7D32').text(
      isIncludedTrapCheck
        ? 'This trap check was included at no additional charge with your rodent trapping service.'
        : 'This callback visit was included at no additional charge with your WaveGuard membership.',
      L + 14, y + 9, { width: W - 28 }
    );
    doc.restore();
    y += 40;
  }

  // ══════════════════════════════════════════════════════
  // LAWN MEASUREMENTS (if applicable)
  // ══════════════════════════════════════════════════════
  const measurements = [];
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
  // PRODUCTS APPLIED — enhanced with EPA, target pests, dilution
  // ══════════════════════════════════════════════════════
  if (products.length) {
    y = sectionHeader(doc, 'Products Applied', L, y);

    products.forEach((p, i) => {
      if (y > 650) { doc.addPage(); y = 50; }

      // Find matching compliance record for this product
      const comp = compliance.find(c => c.product_id === p.product_id) || {};
      const epa = p.epa_reg_number || comp.epa_registration_number || '';
      const dilution = p.catalog_dilution_rate || comp.dilution_rate || '';
      const targetPest = comp.target_pest || '';
      const targetArea = p.application_area || comp.application_site || p.application_method || '';
      const signalWord = p.catalog_signal_word || '';
      const formulation = p.catalog_formulation || '';

      const bg = i % 2 === 0 ? '#fff' : LIGHT_BG;
      const rowH = 42 + (targetPest ? 12 : 0);

      doc.save();
      doc.rect(L, y, W, rowH).fill(bg);

      // Row 1: Product name + Active ingredient + EPA
      doc.fontSize(9).font('Helvetica-Bold').fillColor(BODY).text(p.product_name || '', L + 8, y + 4, { width: 200 });
      if (p.active_ingredient) {
        doc.fontSize(7).font('Helvetica').fillColor('#888').text(`Active: ${p.active_ingredient}${formulation ? ` (${formulation})` : ''}`, L + 8, y + 16, { width: 200 });
      }
      if (epa) {
        doc.fontSize(7).font('Helvetica').fillColor('#888').text(`EPA Reg. #${epa}`, L + 8, y + 26, { width: 200 });
      }
      if (signalWord) {
        doc.fontSize(7).font('Helvetica-Bold').fillColor(signalWord === 'Danger' ? RED : '#B8860B').text(signalWord.toUpperCase(), L + 210, y + 4, { width: 60 });
      }

      // Row 1 right side: Application details
      const detailX = L + 280;
      doc.fontSize(7.5).font('Helvetica').fillColor('#555').text('Method:', detailX, y + 4, { width: 40 });
      doc.font('Helvetica').fillColor(BODY).text(targetArea || '—', detailX + 42, y + 4, { width: 200 });
      doc.fontSize(7.5).fillColor('#555').text('Rate:', detailX, y + 16, { width: 40 });
      doc.fillColor(BODY).text(p.application_rate ? `${p.application_rate} ${p.rate_unit || ''}`.trim() : '—', detailX + 42, y + 16, { width: 200 });
      if (dilution) {
        doc.fontSize(7.5).fillColor('#555').text('Dilution:', detailX, y + 28, { width: 42 });
        doc.fillColor(BODY).text(dilution, detailX + 42, y + 28, { width: 200 });
      }
      if (p.total_amount) {
        doc.fontSize(7.5).fillColor('#555').text('Applied:', detailX + 160, y + 28, { width: 38 });
        doc.fillColor(BODY).text(`${p.total_amount} ${p.amount_unit || ''}`.trim(), detailX + 200, y + 28, { width: 80 });
      }

      // Target pests row
      if (targetPest) {
        doc.fontSize(7.5).font('Helvetica').fillColor(TEAL).text(`Target: ${targetPest}`, L + 8, y + 36, { width: W - 16 });
      }

      doc.restore();
      y += rowH + 2;
    });
    y += 8;
  }

  // ══════════════════════════════════════════════════════
  // WHAT WE DID
  // ══════════════════════════════════════════════════════
  // The same rule as the service-history JSON — this PDF (and its
  // auto_report share links) is a customer render of the same notes: the
  // reviewed report text only, never the tech's raw note, with the legacy
  // inspection-fee scrub on top (context-aggregator.js customerSafeVisitNotes;
  // codex #2817).
  const notes = (customerSafeVisitNotes(service, { projectLine: true }) || '').trim();
  if (notes) {
    if (y > 620) { doc.addPage(); y = 50; }
    y = sectionHeader(doc, 'What We Did', L, y);
    doc.fontSize(9).font('Helvetica').fillColor(BODY).text(notes, L + 8, y, { width: W - 16, lineGap: 3 });
    y = doc.y + 12;
  }

  // ══════════════════════════════════════════════════════
  // WHAT I NOTICED — tech observations from structured_notes + AI report.
  // field_flags are deliberately NOT printed: they are internal QA markers,
  // not customer-facing (see the same classification in routes/services.js),
  // and dumping every key/value put raw internal flags on a customer PDF.
  // ══════════════════════════════════════════════════════
  const observations = [];
  if (structuredNotes?.observations) {
    const obs = Array.isArray(structuredNotes.observations) ? structuredNotes.observations : [structuredNotes.observations];
    observations.push(...obs);
  }
  if (aiReport?.observations) {
    const obs = Array.isArray(aiReport.observations) ? aiReport.observations : [aiReport.observations];
    observations.push(...obs);
  }

  if (observations.length) {
    if (y > 620) { doc.addPage(); y = 50; }
    y = sectionHeader(doc, 'What I Noticed', L, y);
    observations.forEach(obs => {
      if (y > 700) { doc.addPage(); y = 50; }
      doc.fontSize(8.5).font('Helvetica').fillColor(BODY);
      doc.text(`  \u2022  ${obs}`, L + 8, y, { width: W - 24, lineGap: 2 });
      y = doc.y + 4;
    });
    y += 6;
  }

  // ══════════════════════════════════════════════════════
  // WHAT WE RECOMMEND — property-specific tips
  // ══════════════════════════════════════════════════════
  const recommendations = [];
  if (structuredNotes?.recommendations) {
    const recs = Array.isArray(structuredNotes.recommendations) ? structuredNotes.recommendations : [structuredNotes.recommendations];
    recommendations.push(...recs);
  }
  if (aiReport?.recommendations) {
    const recs = Array.isArray(aiReport.recommendations) ? aiReport.recommendations : [aiReport.recommendations];
    recommendations.push(...recs);
  }
  if (service.irrigation_recommendation) {
    try {
      const irr = typeof service.irrigation_recommendation === 'string' ? JSON.parse(service.irrigation_recommendation) : service.irrigation_recommendation;
      if (irr.recommendation) recommendations.push(irr.recommendation);
    } catch { /* ignore */ }
  }

  if (recommendations.length) {
    if (y > 620) { doc.addPage(); y = 50; }
    y = sectionHeader(doc, 'What We Recommend', L, y);
    doc.save();
    doc.roundedRect(L, y, W, 4 + recommendations.length * 16, 3).fill(LIGHT_BG);
    doc.roundedRect(L, y, 4, 4 + recommendations.length * 16, 2).fill(TEAL);
    recommendations.forEach((rec, i) => {
      doc.fontSize(8.5).font('Helvetica').fillColor(BODY);
      doc.text(`  \u2022  ${rec}`, L + 14, y + 6 + i * 16, { width: W - 28, lineGap: 2 });
    });
    doc.restore();
    y += 10 + recommendations.length * 16;
  }

  // ══════════════════════════════════════════════════════
  // WHAT'S NEXT — aftercare tips
  // ══════════════════════════════════════════════════════
  if (y > 640) { doc.addPage(); y = 50; }
  y = sectionHeader(doc, "What's Next", L, y);
  doc.save();
  doc.roundedRect(L, y, W, 36, 3).fill('#F0FAF0');
  doc.roundedRect(L, y, 4, 36, 2).fill(GREEN);
  doc.fontSize(9).font('Helvetica').fillColor(BODY).text(
    getAftercareTips(service.service_type),
    L + 14, y + 6, { width: W - 28, lineGap: 3 }
  );
  doc.restore();
  y += 46;

  // ══════════════════════════════════════════════════════
  // SERVICE VALUE (if invoice exists)
  // ══════════════════════════════════════════════════════
  if (invoice && invoice.total_amount) {
    if (y > 690) { doc.addPage(); y = 50; }
    doc.save();
    doc.roundedRect(L, y, W, 22, 3).fill(LIGHT_BG);
    doc.fontSize(8).font('Helvetica').fillColor('#555').text('Service Value:', L + 10, y + 6);
    doc.font('Helvetica-Bold').fillColor(NAVY).text(`$${Number(invoice.total_amount).toFixed(2)}`, L + 85, y + 6);
    if (isCallback) {
      doc.font('Helvetica').fillColor(GREEN).text(isIncludedTrapCheck ? 'Included with your trapping service — $0.00 billed' : 'Included with WaveGuard — $0.00 billed', L + 160, y + 6);
    } else {
      doc.font('Helvetica').fillColor('#555').text('View full invoice at portal.wavespestcontrol.com', L + 160, y + 6);
    }
    doc.restore();
    y += 30;
  }

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
    'National Poison Control: (800) 222-1222 | FL Dept. of Agriculture: (850) 617-7870',
    L + 10, y + 18, { width: W - 20 }
  );
  doc.restore();
  y += 36;

  // ══════════════════════════════════════════════════════
  // FOOTER
  // ══════════════════════════════════════════════════════
  const previousBottomMargin = doc.page.margins.bottom;
  doc.save();
  doc.page.margins.bottom = 0;
  doc.rect(0, 730, 612, 62).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(
    `Waves Pest Control, LLC · ${credentialText}`,
    0, 738, { width: 612, align: 'center' }
  );
  doc.fontSize(7).font('Helvetica').fillColor(MUTED_ON_DARK).text(
    `${WAVES_ADDRESS_LINE} · ${WAVES_SUPPORT_PHONE_DISPLAY}`,
    0, 750, { width: 612, align: 'center' }
  );
  const techLine = service.technician_name && service.technician_name !== 'Waves Team'
    ? `Your technician: ${service.technician_name}${service.technician_license ? ` (FL #${service.technician_license})` : ''}`
    : 'wavespestcontrol.com';
  doc.text(techLine, 0, 760, { width: 612, align: 'center' });
  doc.fillColor(MUTED).text(
    'View this report in your Waves portal · National Poison Control: (800) 222-1222',
    0, 770, { width: 612, align: 'center' }
  );
  // Owner ask 2026-09-28: every report links to the public Products & Safety
  // page, this Documents-API PDF (visits with no report token) included. The
  // URL prints in full for paper copies; it fits the band above the page edge.
  doc.fillColor(MUTED_ON_DARK).text(
    `Every product we use and our safety protocol: ${WAVES_PRODUCTS_SAFETY_URL}`,
    0, 780, { width: 612, align: 'center', link: `${WAVES_PRODUCTS_SAFETY_URL}#safety-protocol` }
  );
  doc.page.margins.bottom = previousBottomMargin;
  doc.restore();

  doc.end();
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(typeof d === 'string' ? d + 'T12:00:00' : d);
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function storedDocumentHasFile(doc) {
  return Boolean(doc && typeof doc.s3_key === 'string' && doc.s3_key.trim());
}

async function redirectToStoredDocument(doc, res) {
  if (!storedDocumentHasFile(doc)) {
    return res.status(404).json({ error: 'Document file is not available' });
  }

  try {
    const url = await PhotoService.getDownloadUrl(doc.s3_key, doc.file_name, 15 * 60);
    return res.redirect(302, url);
  } catch (err) {
    logger.error(`[documents] failed to sign stored document id=${doc.id}: ${err.message}`);
    return res.status(503).json({ error: 'Document is temporarily unavailable. Please try again.' });
  }
}

// Contact session (GATE_CONTACT_LOGIN): the report rule decides what the
// contact's OWN session may read (services/contact-session-projection.js —
// the same verdict GET /api/services applies).
const {
  contactSessionReportsWithheld: contactReportsWithheld, contactSafeReportCustomer, contactRecordScope, scopeContactRecords, contactAddress,
} = require('../services/contact-session-projection');

// Pagination — caps total result size to prevent runaway payloads for
// long-tenured customers with years of service history.
function documentPageBounds(query) {
  return {
    limit: Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 200),
    offset: Math.max(parseInt(query.offset, 10) || 0, 0),
  };
}

// Signed contracts (customer_contracts: service agreements, the AutoPay
// authorization, signed notices and forms) are the customer's documents too.
// The executed copy is the same branded PDF the signed-copy email carried,
// served by GET /api/documents/contract/:id/download below (customer-scoped).
// Only a SIGNED row is listed: an open signing link is not a document yet, and
// its single-use token must never surface here.
const CONTRACT_DOCUMENT_ID_PREFIX = 'contract_';

function signedContractsQuery(customerId) {
  return db('customer_contracts as cc')
    .leftJoin('document_templates as dt', 'cc.document_template_id', 'dt.id')
    .where({ 'cc.customer_id': customerId, 'cc.status': 'signed' });
}

// Agreements for service agreements and the AutoPay authorization; every other
// signed form (a notice, a prep form) files under Other Paperwork.
function contractDocumentType(row) {
  if (row.contract_type === 'autopay_authorization') return 'service_agreement';
  return row.document_template_document_type === 'service_agreement' ? 'service_agreement' : 'other';
}

// signed_at is a timestamp (formatDate above takes a date-only string).
function signedOnLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function contractDocumentEntry(row) {
  const signedOn = row.signed_at && !Number.isNaN(new Date(row.signed_at).getTime()) ? new Date(row.signed_at).toISOString().slice(0, 10) : 'signed';
  return {
    id: `${CONTRACT_DOCUMENT_ID_PREFIX}${row.id}`,
    documentType: contractDocumentType(row),
    title: row.title || 'Waves Agreement',
    description: `Signed ${signedOnLabel(row.signed_at)}${row.service_name ? ` · ${row.service_name}` : ''}`,
    fileName: `${String(row.title || 'Waves_Agreement').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Waves_Agreement'}_${signedOn}.pdf`,
    uploadedBy: 'auto_generated',
    createdAt: row.signed_at || row.created_at,
    isAutoGenerated: true,
    isSignedContract: true,
    signedAt: row.signed_at,
    downloadUrl: `/api/documents/contract/${row.id}/download`,
    // The executed copy is served only to this customer's session; no public share link is minted for it.
    shareable: false,
  };
}

// Both reads list none on an older database without the table rather than failing the whole page.
async function signedContractDocuments(customerId, page) {
  try {
    const rows = await signedContractsQuery(customerId)
      .select('cc.id', 'cc.contract_type', 'cc.title', 'cc.service_name', 'cc.signed_at', 'cc.created_at', 'dt.document_type as document_template_document_type')
      .orderBy('cc.signed_at', 'desc')
      .limit(page.limit)
      .offset(page.offset);
    return rows.map(contractDocumentEntry);
  } catch (err) {
    logger.warn(`[documents] signed contracts skipped for customer ${customerId}: ${err.code || err.message}`);
    return [];
  }
}

async function signedContractCount(customerId) {
  try {
    const [{ count }] = await signedContractsQuery(customerId).count('cc.id as count');
    return parseInt(count, 10) || 0;
  } catch {
    return 0;
  }
}

// Completed service records whose visit report the customer may list — the
// list and its cross-page count read the same predicate. Project-backed
// completions use the Project report itself as the customer artifact, so do
// not create a second generic service-report document for the same work;
// internal_only typed completions (Phase-1b shadow) store a report for admin
// review only, so they are no "Visit Report" entry either — filtered in SQL
// (the same predicate every customer artifact applies) so a hidden report
// neither consumes a page slot nor counts toward the total (codex #6363 r33
// P2). `scope` (a contact session): the primary property's visits only
// (codex r16 P1) — the holder's other saved homes are not theirs to read.
function completedServiceReportsQuery(customerId, serviceRecordCols, scope = null) {
  let query = applyCustomerVisibleServiceRecordFilter(db('service_records')
    .where({ 'service_records.customer_id': customerId, 'service_records.status': 'completed' }));
  if (scope) {
    query = scopeContactRecords(
      query.leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id'),
      scope,
    );
  }
  if (serviceRecordCols.completion_source) {
    query = query.where(function visibleServiceReports() {
      this.whereNull('service_records.completion_source')
        .orWhereNot('service_records.completion_source', 'project_completion');
    });
  }
  return query;
}

function selectServiceReportPage(query, { limit, offset }) {
  return query
    .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
    .select(
      'service_records.id',
      'service_records.service_date',
      'service_records.service_type',
      'service_records.report_view_token',
      'service_records.report_template_version',
      'service_records.structured_notes',
      'technicians.name as technician_name',
    )
    .orderBy('service_records.service_date', 'desc')
    .limit(limit)
    .offset(offset);
}

// First service photo per visit — the Documents tab renders service reports
// as a visual slider (owner 2026-07-09), so each entry carries a preview
// image when the tech captured photos. Fail-open: any error just means no
// image, never a broken documents list.
async function previewPhotosFor(serviceIds) {
  const previewPhotoByServiceId = new Map();
  if (!serviceIds.length) return previewPhotoByServiceId;
  try {
    const photoRows = await db('service_photos')
      .whereIn('service_record_id', serviceIds)
      .orderBy('sort_order')
      .orderBy('created_at');
    for (const photo of photoRows) {
      if (!previewPhotoByServiceId.has(photo.service_record_id)) {
        previewPhotoByServiceId.set(photo.service_record_id, photo);
      }
    }
  } catch (err) {
    if (err?.code !== '42P01') logger.warn(`[documents] preview photo lookup failed: ${err.message}`);
  }
  return previewPhotoByServiceId;
}

async function previewImageUrl(photo) {
  if (!photo) return null;
  // Presign from s3_key FIRST — stored s3_url values expire/go stale;
  // legacy fallback only (same order as the report photo resolver).
  if (photo.s3_key) {
    try {
      const PhotoService = require('../services/photos');
      return await PhotoService.getViewUrl(photo.s3_key, PhotoService.CUSTOMER_DWELL_TTL_SECONDS);
    } catch {
      /* fall through to the legacy stored URL */
    }
  }
  return photo.s3_url || null;
}

// The auto-generated "Visit Report" entries for a page of completed
// services — the holder's list and a contact's share this. `docs` (the
// holder's stored documents): a visit whose report the holder keeps a stored
// copy of is not listed twice. `contactOnly`: a contact session lists every
// completed visit (a holder's linked stored copy is not theirs to read) and
// reaches the report ONLY through the authenticated, contact-safe PDF
// route — the public /report and /api/reports bearers render the holder's
// identity (codex #6363 r4 P1).
async function serviceReportEntries(services, { docs = [], contactOnly = false } = {}) {
  const linkedServiceIds = new Set(docs.filter(d => d.linked_service_record_id).map(d => d.linked_service_record_id));
  const deliveryByServiceId = new Map();
  const serviceIds = services.map((svc) => svc.id);
  if (serviceIds.length) {
    const deliveries = await db('service_report_deliveries')
      .whereIn('service_record_id', serviceIds)
      .where({ channel: 'email', report_template_version: 'service_report_v1' })
      .select('service_record_id', 'status', 'updated_at', 'sent_at')
      .catch((err) => {
        if (err?.code === '42P01') return [];
        throw err;
      });
    for (const delivery of deliveries) deliveryByServiceId.set(delivery.service_record_id, delivery);
  }
  const previewPhotoByServiceId = await previewPhotosFor(serviceIds);

  const entries = [];
  for (const svc of services) {
    if (!contactOnly && linkedServiceIds.has(svc.id) && docs.find(d => d.linked_service_record_id === svc.id && d.document_type === 'service_report')) continue;
    const reportToken = contactOnly ? null : (svc.report_view_token || null);
    const viewUrl = reportToken ? `/report/${reportToken}` : null;
    const pdfUrl = reportToken ? `/api/reports/${reportToken}` : `/api/documents/service-report/${svc.id}`;
    const isServiceReportV1 = svc.report_template_version === 'service_report_v1';
    const delivery = isServiceReportV1 ? deliveryByServiceId.get(svc.id) : null;
    entries.push({
      id: `auto_report_${svc.id}`,
      documentType: 'service_report',
      previewImage: await previewImageUrl(previewPhotoByServiceId.get(svc.id)),
      title: `Visit Report — ${svc.service_type}`,
      description: isServiceReportV1
        ? `Infographic service report for ${formatDate(svc.service_date)}`
        : `Full service summary for ${formatDate(svc.service_date)}`,
      fileName: `Service_Report_${svc.service_date}.pdf`,
      uploadedBy: 'auto_generated',
      linkedServiceRecordId: svc.id,
      serviceDate: svc.service_date,
      createdAt: svc.service_date,
      isAutoGenerated: true,
      isServiceReportV1,
      reportToken,
      viewUrl,
      pdfUrl,
      downloadUrl: viewUrl || pdfUrl,
      deliveryStatus: delivery
        ? { email: delivery.status, sentAt: delivery.sent_at, updatedAt: delivery.updated_at }
        : null,
    });
  }
  return entries;
}

function groupDocumentsByType(allDocs) {
  const grouped = {};
  for (const d of allDocs) {
    if (!grouped[d.documentType]) grouped[d.documentType] = [];
    grouped[d.documentType].push(d);
  }
  return grouped;
}

// GET /api/documents for a CONTACT session (GATE_CONTACT_LOGIN): the primary
// property's completed visit reports only — no stored documents (agreements,
// invoices), no inspection or compliance reports, and no project reports
// either (those live only behind their public /report/project bearer, which
// renders the holder's name, email, phone and a pay link; codex #6363 r4 P1)
// — and nothing at all when the report rule withholds from this contact. The
// total counts the same scoped reports (codex r18 P2): the holder's other
// homes' reports are neither listed nor counted.
async function listContactServiceReports(req, res) {
  if (await contactReportsWithheld(req)) return res.json({ documents: {}, total: 0 });
  const page = documentPageBounds(req.query);
  const serviceRecordCols = await db('service_records').columnInfo().catch(() => ({}));
  const scope = await contactRecordScope(req);
  const services = await selectServiceReportPage(completedServiceReportsQuery(req.customerId, serviceRecordCols, scope), page);
  const reports = await serviceReportEntries(services, { contactOnly: true });
  const [{ count }] = await completedServiceReportsQuery(req.customerId, serviceRecordCols, scope).count('service_records.id as count');
  return res.json({ documents: groupDocumentsByType(reports), total: parseInt(count, 10) });
}

// =========================================================================
// GET /api/documents — all documents for authenticated customer
// =========================================================================
router.get('/', authenticate, async (req, res, next) => {
  try {
    if (req.contactSession) return await listContactServiceReports(req, res);
    const page = documentPageBounds(req.query);

    // Get uploaded/static documents
    const docs = await db('customer_documents')
      .where({ customer_id: req.customerId })
      .orderBy('created_at', 'desc')
      .limit(page.limit)
      .offset(page.offset);

    const [serviceRecordCols, projectCols] = await Promise.all([
      db('service_records').columnInfo().catch(() => ({})),
      db('projects').columnInfo().catch(() => ({})),
    ]);

    // Auto-generated service_report entries for completed services
    const services = await selectServiceReportPage(completedServiceReportsQuery(req.customerId, serviceRecordCols), page);
    const autoGenDocs = await serviceReportEntries(services, { docs });

    // Signed agreements, authorizations and forms (customer_contracts).
    const contractDocs = await signedContractDocuments(req.customerId, page);

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
      downloadUrl: storedDocumentHasFile(d) ? `/api/documents/${d.id}/download` : null,
      shareable: storedDocumentHasFile(d),
    }));

    // Auto-generate entries for 'sent' projects (WDO, termite, rodent, etc.).
    // Project reports live at /report/project/:token and map to the Visit
    // Reports or Real Estate category depending on project_type.
    let projectsQuery = db('projects as p')
      .leftJoin('customers as c', 'p.customer_id', 'c.id')
      .where({ 'p.customer_id': req.customerId })
      .whereIn('p.status', ['sent', 'closed'])
      .whereNotNull('report_token');
    if (projectCols.portal_visible) {
      projectsQuery = projectsQuery.where(function portalVisibleProjects() {
        this.where('p.portal_visible', true)
          // Legacy sent reports predate the explicit portal visibility
          // column. Keep them visible unless a closeout explicitly sets false.
          .orWhere(function legacySentProject() {
            this.whereNull('p.portal_visible').where('p.status', 'sent');
          });
      });
    } else {
      projectsQuery = projectsQuery.where('p.status', 'sent');
    }
    projectsQuery = projectsQuery.select('p.*', 'c.first_name', 'c.last_name');
    if (projectCols.closed_at) {
      projectsQuery = projectsQuery.orderByRaw('COALESCE(p.sent_at, p.closed_at, p.created_at) DESC');
    } else {
      projectsQuery = projectsQuery.orderBy('p.sent_at', 'desc').orderBy('p.created_at', 'desc');
    }
    const projects = await projectsQuery;

    const projectDocs = await Promise.all(projects.map(async (p) => {
      const isWdo = p.project_type === 'wdo_inspection';
      const isCertificate = p.project_type === 'pre_treatment_termite_certificate';
      const typeLabels = {
        wdo_inspection: 'WDO Inspection',
        termite_inspection: 'Termite Inspection',
        termite_treatment: 'Termite Treatment',
        pest_inspection: 'Pest Inspection',
        flea: 'Flea Service',
        rodent_exclusion: 'Rodent Exclusion',
        rodent_trapping: 'Rodent Trapping',
        wildlife_trapping: 'Wildlife Trapping',
        one_time_pest_treatment: 'One-Time Pest Treatment',
        one_time_lawn_treatment: 'One-Time Lawn Treatment',
        mosquito_event: 'Mosquito Event Spray',
        palm_injection: 'Palm Injection',
        bed_bug: 'Bed Bug Treatment Service',
        pre_treatment_termite_certificate: 'Certificate of Compliance',
      };
      const label = typeLabels[p.project_type] || getProjectType(p.project_type)?.label || 'Project';
      const viewUrl = await projectReportPathForProject(db, p, p);
      // Compliance certificates belong in the Compliance category, not
      // Service Reports — they live in the permit folder and are referenced
      // by lenders, building inspectors, and the property owner long after
      // any single service visit.
      const documentType = isWdo
        ? 'wdo_inspection'
        : isCertificate
        ? 'compliance_certificate'
        : 'service_report';
      return {
        id: `project_${p.id}`,
        documentType,
        // same type-gated fee scrub as the report page headline, cue AND
        // recorded-value passes — covers a legacy title (or a CAS-skipped
        // concurrent write) at this egress even when it paraphrases the fee
        // without the literal cue (codex #2817)
        title: (p.title
          ? (() => {
            const safe = redactInspectionFeeCuesForType(p.title, p.project_type);
            return projectTypeHasInternalFindingKeys(p.project_type)
              ? redactSpecificAmounts(safe, projectRecordedFeeValues(p))
              : safe;
          })()
          : null)
          || (isCertificate ? label : `${label} Report`),
        description: p.sent_at ? `Report sent ${formatDate(p.sent_at)}` : label,
        fileName: `${label.replace(/\s+/g, '_')}_${p.sent_at ? new Date(p.sent_at).toISOString().slice(0, 10) : 'report'}.pdf`,
        uploadedBy: 'auto_generated',
        createdAt: p.sent_at || p.created_at,
        isAutoGenerated: true,
        isProjectReport: true,
        projectType: p.project_type,
        viewUrl: viewUrl || `/report/project/${p.report_token}`,
        downloadUrl: viewUrl || `/report/project/${p.report_token}`,
      };
    }));

    // Group by type
    // Real cross-page totals: `total` previously reported THIS page's length,
    // so the client's "N total on file" label could never exceed the page and
    // paging looked complete after one fetch. Counts are per-source (stored
    // docs + completed-service reports + project reports); the handful of
    // page-level skips (internal-only typed reports, linked-doc dedup) make
    // this a slight upper bound, which the label tolerates.
    const [{ count: storedDocCount }] = await db('customer_documents')
      .where({ customer_id: req.customerId })
      .count('id as count');
    const [{ count: serviceReportCount }] = await completedServiceReportsQuery(req.customerId, serviceRecordCols)
      .count('service_records.id as count');
    const contractCount = await signedContractCount(req.customerId);

    const allDocs = [...formattedDocs, ...autoGenDocs, ...projectDocs, ...contractDocs];
    const totalOnFile = parseInt(storedDocCount, 10) + parseInt(serviceReportCount, 10) + projectDocs.length + contractCount;

    res.json({ documents: groupDocumentsByType(allDocs), total: totalOnFile });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/documents/service-report/:serviceRecordId — auto-generate PDF
// =========================================================================
router.get('/service-report/:serviceRecordId', authenticate, async (req, res, next) => {
  try {
    // 404 (not 403) for a withheld contact so the record isn't signposted.
    if (await contactReportsWithheld(req)) return res.status(404).json({ error: 'Service record not found' });
    // A contact opens the primary property's reports only (codex #6363 r16
    // P1): a record of the holder's other home is a 404 here too.
    const scope = req.contactSession ? await contactRecordScope(req) : null;
    let serviceQuery = db('service_records')
      .where({ 'service_records.id': req.params.serviceRecordId, 'service_records.customer_id': req.customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id');
    if (scope) {
      serviceQuery = scopeContactRecords(
        serviceQuery.leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id'),
        scope,
      );
    }
    const service = await serviceQuery
      .select(
        'service_records.*',
        'technicians.name as technician_name',
        'technicians.phone as technician_phone',
        'technicians.fl_applicator_license as technician_license',
      )
      .first();

    if (!service) return res.status(404).json({ error: 'Service record not found' });

    // internal_only typed completions (Phase-1b shadow) are admin-review
    // only — this authenticated fallback generator must refuse them too,
    // since the portal client falls back here exactly when reportUrl is
    // suppressed. 404 (not 403) so the record's existence isn't signposted.
    let reportNotes = {};
    try {
      reportNotes = typeof service.structured_notes === 'string'
        ? JSON.parse(service.structured_notes)
        : (service.structured_notes || {});
    } catch { reportNotes = {}; }
    if (reportNotes.typedReportDelivery && reportNotes.typedReportDelivery !== 'auto_send') {
      return res.status(404).json({ error: 'Service record not found' });
    }

    // Get products with catalog enrichment (EPA, dilution, signal word)
    const products = await db('service_products as sp')
      .where({ 'sp.service_record_id': service.id })
      .leftJoin('products_catalog as pc', function () {
        this.on('pc.name', 'sp.product_name')
          .orOn('pc.name', 'sp.product_name');
      })
      .select(
        'sp.*',
        'pc.dilution_rate as catalog_dilution_rate',
        'pc.signal_word as catalog_signal_word',
        'pc.rain_free_hours as catalog_rain_free_hours',
        'pc.formulation as catalog_formulation',
        'pc.restricted_use as catalog_restricted_use',
      );

    // Get compliance records for EPA reg numbers and target pests.
    // Retracted rows (recap deselection corrections) never reach the
    // customer report (codex P1, PR #3419): the report must not claim
    // treatment that was corrected away.
    const compliance = await db('property_application_history')
      .where({ service_record_id: service.id })
      .whereNull('retracted_at')
      .select('product_id', 'epa_registration_number', 'target_pest', 'application_method',
        'dilution_rate', 'area_treated_sqft', 'wind_speed_mph', 'weather_conditions', 'application_site')
      .catch(() => []);

    // Get invoice total if available. The column is `total` — the old
    // `total_amount` select threw on every request and the .catch() silently
    // dropped the invoice block from the PDF. Never for a contact session:
    // the invoice is the holder's (codex #6363 r2 P1).
    const invoice = req.contactSession ? null : await db('invoices')
      .where({ customer_id: req.customerId })
      .where('service_date', service.service_date)
      .select('total as total_amount', 'status', 'id')
      .first()
      .catch(() => null);

    const credentialText = await getServiceReportCredentialText();
    // Same completion-time identity the tokenized report renders (name,
    // serviced address, technician, product facts) — the portal download
    // must not diverge from the /report/:token preview after a customer,
    // technician, or catalog edit.
    const frozen = applyReportIdentitySnapshotToLegacyPdf({ customer: req.customer, service, products });
    // A contact's copy is addressed to the contact and carries the property
    // facts only — never the holder's name, phone, email or plan (the same
    // projection the contact's own session reads; codex #6363 r2 P1). A
    // legacy record with no frozen address is labeled with the house the
    // contact's reads are scoped to (contactAddress), never the customer
    // row's retired primary (codex r33 P2); a snapshot's own address stays.
    const pdfCustomer = req.contactSession
      ? contactSafeReportCustomer(frozen.customer, req.contactSession, {
        address: readReportIdentitySnapshot(service)?.address ? null : contactAddress(frozen.customer, scope),
      })
      : frozen.customer;
    generateServiceReportPDF(pdfCustomer, frozen.service, frozen.products, res, { compliance, invoice, credentialText, withholdPlan: !!req.contactSession });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/documents/contract/:id/download — the executed copy of a signed
// contract (the same branded PDF the signed-copy email carried). Customer-
// scoped: the row must belong to the session's customer and be signed; an
// open contract (its single-use signing link still live) is a 404 here.
// =========================================================================
router.get('/contract/:id/download', authenticate, noStore, async (req, res, next) => {
  try {
    // Signed agreements are never a contact's to read (same rule as stored documents).
    if (req.contactSession) return res.status(404).json({ error: 'Document not found' });
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Document not found' });
    const contract = await signedContractsQuery(req.customerId)
      .where('cc.id', req.params.id)
      .select('cc.*', 'dt.requires_signature as document_template_requires_signature')
      .first();
    if (!contract) return res.status(404).json({ error: 'Document not found' });
    const customer = await db('customers').where({ id: req.customerId }).first('first_name', 'last_name', 'company_name');
    const { generateContractPDF } = require('../services/pdf/contract-pdf');
    return generateContractPDF(contract, customer || {}, res, { signed: true });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/documents/:id/download — download uploaded document
// =========================================================================
router.get('/:id/download', authenticate, async (req, res, next) => {
  try {
    // Stored documents (agreements, invoices) are never a contact's to read.
    if (req.contactSession) return res.status(404).json({ error: 'Document not found' });
    const doc = await db('customer_documents')
      .where({ id: req.params.id, customer_id: req.customerId })
      .first();

    if (!doc) return res.status(404).json({ error: 'Document not found' });

    return redirectToStoredDocument(doc, res);
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
    const isAutoGen = typeof docId === 'string' && docId.startsWith('auto_report_');

    let storedDocId = null;
    let serviceRecordId = null;

    if (isAutoGen) {
      // Auto-generated report id format: auto_report_<service_record_uuid>
      serviceRecordId = docId.slice('auto_report_'.length);
      // Validate the service record actually belongs to this customer
      const svc = await db('service_records')
        .where({ id: serviceRecordId, customer_id: req.customerId })
        .first()
        .catch(() => null);
      if (!svc) return res.status(404).json({ error: 'Document not found' });
      // Suppressed typed reports (internal_only shadow / disabled kill
      // switch) are not shareable either — ownership alone isn't enough,
      // or a crafted share request mints a public PDF link for a record
      // every other customer surface hides.
      let shareNotes = {};
      try {
        shareNotes = typeof svc.structured_notes === 'string'
          ? JSON.parse(svc.structured_notes)
          : (svc.structured_notes || {});
      } catch { shareNotes = {}; }
      if (shareNotes.typedReportDelivery && shareNotes.typedReportDelivery !== 'auto_send') {
        return res.status(404).json({ error: 'Document not found' });
      }
    } else {
      const doc = await db('customer_documents')
        .where({ id: docId, customer_id: req.customerId })
        .first();
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!storedDocumentHasFile(doc)) {
        return res.status(409).json({ error: 'This document does not have a downloadable file yet.' });
      }
      storedDocId = doc.id;

      await db('customer_documents')
        .where({ id: docId })
        .update({ is_shared_with_third_party: true });
    }

    const shareToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    await db('document_share_links').insert({
      document_id: storedDocId,
      service_record_id: serviceRecordId,
      customer_id: req.customerId,
      share_token: shareToken,
      expires_at: expiresAt,
    });

    const base = process.env.PORTAL_BASE_URL || 'https://portal.wavespestcontrol.com';
    const shareLink = `${base}/api/documents/shared/${shareToken}`;

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

// =========================================================================
// GET /api/documents/shared/:token — public, unauthenticated fetch of a
// shared document. Token is 32-byte crypto-random; expiration enforced;
// access is counted for audit.
// =========================================================================
// The only unauthenticated route in this file, and it serves customer PII
// (full service-report PDFs). The 64-hex gate below blocks enumeration
// noise; this limiter caps how fast anyone can even try (security review
// 2026-08-07). Legit use is a handful of opens per shared link.
const sharedDocLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').rateLimitKey,
  message: { error: 'Too many requests — please slow down.' },
});

router.get('/shared/:token', sharedDocLimiter, async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return res.status(404).json({ error: 'Invalid share link' });
    }

    const link = await db('document_share_links').where({ share_token: token }).first();
    if (!link) return res.status(404).json({ error: 'Share link not found' });
    if (new Date(link.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Share link expired' });
    }

    await db('document_share_links')
      .where({ id: link.id })
      .update({ access_count: db.raw('COALESCE(access_count, 0) + 1') })
      .catch(() => { /* best-effort */ });

    // Auto-generated service report — render the PDF on the fly.
    if (link.service_record_id && link.customer_id) {
      const service = await db('service_records')
        .where({ 'service_records.id': link.service_record_id, 'service_records.customer_id': link.customer_id })
        .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
        .select(
          'service_records.*',
          'technicians.name as technician_name',
          'technicians.phone as technician_phone',
          'technicians.fl_applicator_license as technician_license',
        )
        .first();
      if (!service) return res.status(404).json({ error: 'Document not found' });

      // Defense in depth: even a previously-minted share link must not
      // render a suppressed typed report (internal_only / disabled).
      let sharedNotes = {};
      try {
        sharedNotes = typeof service.structured_notes === 'string'
          ? JSON.parse(service.structured_notes)
          : (service.structured_notes || {});
      } catch { sharedNotes = {}; }
      if (sharedNotes.typedReportDelivery && sharedNotes.typedReportDelivery !== 'auto_send') {
        return res.status(404).json({ error: 'Document not found' });
      }

      const customer = await db('customers').where({ id: link.customer_id }).first();
      if (!customer) return res.status(404).json({ error: 'Document not found' });

      const products = await db('service_products as sp')
        .where({ 'sp.service_record_id': service.id })
        .leftJoin('products_catalog as pc', 'pc.name', 'sp.product_name')
        .select(
          'sp.*',
          'pc.dilution_rate as catalog_dilution_rate',
          'pc.signal_word as catalog_signal_word',
          'pc.rain_free_hours as catalog_rain_free_hours',
          'pc.formulation as catalog_formulation',
          'pc.restricted_use as catalog_restricted_use',
        );

      // Same active-row predicate as the authenticated report reader:
      // retracted applications stay out of the tokenized customer report.
      const compliance = await db('property_application_history')
        .where({ service_record_id: service.id })
        .whereNull('retracted_at')
        .catch(() => []);

      const credentialText = await getServiceReportCredentialText();
      const frozen = applyReportIdentitySnapshotToLegacyPdf({ customer, service, products });
      return generateServiceReportPDF(frozen.customer, frozen.service, frozen.products, res, { compliance, credentialText });
    }

    // Stored document — mint the S3 URL only after the public share token has
    // been validated, so object storage remains private and revocable.
    if (link.document_id) {
      const doc = await db('customer_documents')
        .where({ id: link.document_id, customer_id: link.customer_id })
        .first();
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      return redirectToStoredDocument(doc, res);
    }

    return res.status(404).json({ error: 'Document not found' });
  } catch (err) {
    next(err);
  }
});

router._test = { storedDocumentHasFile };

module.exports = router;
