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

function generateServiceReportPDF(customer, service, products, res, extra = {}) {
  const { compliance = [], invoice = null } = extra;
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });

  // Build filename: firstName-lastName-YYYY-MM-DD.pdf
  const svcDate = new Date(typeof service.service_date === 'string' ? service.service_date + 'T12:00:00' : service.service_date);
  const dateStr = `${svcDate.getFullYear()}-${String(svcDate.getMonth() + 1).padStart(2, '0')}-${String(svcDate.getDate()).padStart(2, '0')}`;
  const fileName = `${customer.first_name}-${customer.last_name}-${dateStr}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  doc.pipe(res);

  const L = 40, R = 572, W = R - L;
  const customerName = `${customer.first_name} ${customer.last_name}`;
  const visitDuration = getVisitDuration(service);
  const isCallback = service.is_callback || (service.service_type && service.service_type.toLowerCase().includes('callback'));

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
  doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('WAVES', L + 10, 18);
  doc.fontSize(9).font('Helvetica').fillColor(TEAL).text('LAWN & PEST CONTROL', L + 10, 42);
  doc.fontSize(8).fillColor('#ccc').text('Licensed & Insured | FL License #JF336375', L + 10, 56);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text('(941) 318-7612', R - 150, 22, { width: 150, align: 'right' });
  doc.fontSize(8).font('Helvetica').fillColor('#ccc').text('wavespestcontrol.com', R - 150, 36, { width: 150, align: 'right' });
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
  y = infoRow(doc, 'City:', `${customer.city || ''}, ${customer.state || 'FL'} ${customer.zip || ''}`, L + 8, y, 70, 180);
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
    const inTime = new Date(service.check_in_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const outTime = service.check_out_time ? new Date(service.check_out_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—';
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
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#333').text(p.product_name || '', L + 8, y + 4, { width: 200 });
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
      doc.font('Helvetica').fillColor('#333').text(targetArea || '—', detailX + 42, y + 4, { width: 200 });
      doc.fontSize(7.5).fillColor('#555').text('Rate:', detailX, y + 16, { width: 40 });
      doc.fillColor('#333').text(p.application_rate ? `${p.application_rate} ${p.rate_unit || ''}`.trim() : '—', detailX + 42, y + 16, { width: 200 });
      if (dilution) {
        doc.fontSize(7.5).fillColor('#555').text('Dilution:', detailX, y + 28, { width: 42 });
        doc.fillColor('#333').text(dilution, detailX + 42, y + 28, { width: 200 });
      }
      if (p.total_amount) {
        doc.fontSize(7.5).fillColor('#555').text('Applied:', detailX + 160, y + 28, { width: 38 });
        doc.fillColor('#333').text(`${p.total_amount} ${p.amount_unit || ''}`.trim(), detailX + 200, y + 28, { width: 80 });
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
  const notes = (service.technician_notes || '').trim();
  if (notes) {
    if (y > 620) { doc.addPage(); y = 50; }
    y = sectionHeader(doc, 'What We Did', L, y);
    doc.fontSize(9).font('Helvetica').fillColor('#333').text(notes, L + 8, y, { width: W - 16, lineGap: 3 });
    y = doc.y + 12;
  }

  // ══════════════════════════════════════════════════════
  // WHAT I NOTICED — tech observations from field_flags, structured_notes, AI report
  // ══════════════════════════════════════════════════════
  let fieldObs = null;
  if (service.field_flags) {
    try {
      const parsed = typeof service.field_flags === 'string' ? JSON.parse(service.field_flags) : service.field_flags;
      if (Object.keys(parsed).length) fieldObs = parsed;
    } catch { /* ignore */ }
  }

  const observations = [];
  if (fieldObs) {
    Object.entries(fieldObs).forEach(([key, val]) => {
      if (typeof val === 'boolean' && !val) return;
      observations.push(`${key.replace(/_/g, ' ')}: ${typeof val === 'boolean' ? 'Yes' : val}`);
    });
  }
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
      doc.fontSize(8.5).font('Helvetica').fillColor('#333');
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
    doc.roundedRect(L, y, W, 4 + recommendations.length * 16, 3).fill('#F0F7FC');
    doc.roundedRect(L, y, 4, 4 + recommendations.length * 16, 2).fill(TEAL);
    recommendations.forEach((rec, i) => {
      doc.fontSize(8.5).font('Helvetica').fillColor('#333');
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
  doc.fontSize(9).font('Helvetica').fillColor('#333').text(
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
      doc.font('Helvetica').fillColor(GREEN).text('Included with WaveGuard — $0.00 billed', L + 160, y + 6);
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
  doc.save();
  doc.rect(0, 730, 612, 62).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(
    'Waves Pest Control, LLC · FL License #JF336375',
    0, 738, { width: 612, align: 'center' }
  );
  doc.fontSize(7).font('Helvetica').fillColor('#ccc').text(
    '13649 Luxe Ave #110, Bradenton, FL 34211 · (941) 318-7612',
    0, 750, { width: 612, align: 'center' }
  );
  const techLine = service.technician_name && service.technician_name !== 'Waves Team'
    ? `Your technician: ${service.technician_name}${service.technician_license ? ` (FL #${service.technician_license})` : ''}`
    : 'wavespestcontrol.com';
  doc.text(techLine, 0, 760, { width: 612, align: 'center' });
  doc.fillColor('#999').text(
    'View this report in your Waves portal · National Poison Control: (800) 222-1222',
    0, 770, { width: 612, align: 'center' }
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
      .select(
        'service_records.*',
        'technicians.name as technician_name',
        'technicians.phone as technician_phone',
        'technicians.fl_applicator_license as technician_license',
        'technicians.photo_url as technician_photo',
      )
      .first();

    if (!service) return res.status(404).json({ error: 'Service record not found' });

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

    // Get compliance records for EPA reg numbers and target pests
    const compliance = await db('property_application_history')
      .where({ service_record_id: service.id })
      .select('product_id', 'epa_registration_number', 'target_pest', 'application_method',
        'dilution_rate', 'area_treated_sqft', 'wind_speed_mph', 'weather_conditions', 'application_site')
      .catch(() => []);

    // Get invoice total if available
    const invoice = await db('invoices')
      .where({ customer_id: req.customerId })
      .where('service_date', service.service_date)
      .select('total_amount', 'status', 'id')
      .first()
      .catch(() => null);

    const customer = req.customer;
    generateServiceReportPDF(customer, service, products, res, { compliance, invoice });
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
