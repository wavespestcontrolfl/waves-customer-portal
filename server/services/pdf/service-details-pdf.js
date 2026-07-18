// ============================================================
// service-details-pdf.js — per-service details guide PDF
//
// Renders the estimate-service-details content (process + inclusions +
// real-question FAQ + documentation differentiators + safety standard +
// public product registry rows) as a branded per-service guide, with
// estimate-page CTAs so the guide keeps the estimate conversation going.
// Presentation only — content assembly lives in
// services/estimate-service-details.js.
//
// Chrome follows the unified glass document family (doc-style unify #2543):
// pdf-tokens palette, the same navy header bar + soft title band as
// invoice-pdf, warm washes, and gold-pill CTAs matching the estimate page.
// ============================================================

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { getLogoBuffer } = require('./brand-logo');
const { PDF_COLORS, PDF_TYPE } = require('./pdf-tokens');
const {
  WAVES_ADDRESS_LINE,
  WAVES_WEBSITE_HOST,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_FL_LICENSE_LINE,
} = require('../../constants/business');

const NAVY = PDF_COLORS.navy;          // #04395E — canonical customer ink
const BLUE = PDF_COLORS.blue;          // #009CDE
const BODY = PDF_COLORS.body;
const MUTED = PDF_COLORS.muted;
const RULE = PDF_COLORS.rule;
const SOFT = PDF_COLORS.soft;
const HEADER_SUB = PDF_COLORS.headerSub;
const WHITE = PDF_COLORS.white;
const GOLD_PILL = '#FFD700';           // estimate CTA pill fill (theme-brand)

const PAGE_W = 612;
const L = 40;
const W = PAGE_W - 80;
const FOOTER_TOP = 742;
const CONTENT_BOTTOM = FOOTER_TOP - 24;

// Guides are GLOBAL customer documents, so they carry the headquarters
// contact (Town Center Pkwy + main line) per the 2026-07-11 publishing rule;
// the Luxe Ave WAVES_ADDRESS_LINE stays on formal/corporate documents
// (invoices, notices) and Bradenton-specific surfaces.
const GUIDE_ADDRESS_LINE = '9040 Town Center Pkwy, Lakewood Ranch, FL 34202';

// App screenshots (same PNG assets the app-intro email uses) — optional,
// cached; the guide renders fine without them.
const shotCache = new Map();
function getAppShot(name) {
  if (shotCache.has(name)) return shotCache.get(name) || null;
  let buf = null;
  try {
    buf = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'client', 'public', 'app-email', name));
  } catch { /* asset optional */ }
  shotCache.set(name, buf);
  return buf;
}

// Product imagery (server/assets/product-images) — stylized studio renders
// of the program's flagship products, generated in-house (no manufacturer
// photography). Deliberately OUTSIDE client/public: the express.static
// mount there would expose product renders (and their name-bearing
// filenames) regardless of GATE_SERVICE_DETAILS_PDF or the public-registry
// approval the captions are filtered by — these assets only leave the
// server inside the gated PDF. Optional and cached like the app shots.
function getProductShot(name) {
  const key = `product-images/${name}`;
  if (shotCache.has(key)) return shotCache.get(key) || null;
  let buf = null;
  try {
    buf = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'product-images', name));
  } catch { /* asset optional */ }
  shotCache.set(key, buf);
  return buf;
}

// A row of product images with captions — square renders, up to 4 across.
function productImageRow(doc, block) {
  const images = (block?.images || [])
    .map((img) => ({ ...img, buf: getProductShot(img.file) }))
    .filter((img) => img.buf);
  if (!images.length) return;
  const shotW = images.length >= 4 ? 116 : 128;
  const gap = 16;
  const rowW = images.length * shotW + (images.length - 1) * gap;
  const captionH = 30;
  ensureRoom(doc, shotW + captionH + 56);
  if (block.heading) sectionHeading(doc, block.heading);
  doc.moveDown(0.3);
  const top = doc.y;
  let x = L + (W - rowW) / 2;
  for (const img of images) {
    try {
      doc.image(img.buf, x, top, { width: shotW, height: shotW });
      doc.save();
      doc.roundedRect(x, top, shotW, shotW, 8).lineWidth(0.75).strokeColor(RULE).stroke();
      doc.restore();
    } catch { /* asset optional */ }
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(img.caption || '', x - 4, top + shotW + 5, { width: shotW + 8, align: 'center', lineGap: 0.5 });
    x += shotW + gap;
  }
  doc.y = top + shotW + captionH + 4;
  if (block.note) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED)
      .text(block.note, L, doc.y, { width: W, align: 'center', lineGap: 1 });
    doc.moveDown(0.5);
  }
}

function footer(doc) {
  // Zero the bottom margin while drawing in the footer band — pdfkit
  // auto-paginates any text below (pageHeight − bottomMargin), which turned
  // the two footer lines into two phantom pages (same fix as
  // estimate-pdf.js footerBar).
  const previousBottomMargin = doc.page.margins.bottom;
  doc.save();
  doc.page.margins.bottom = 0;
  doc.moveTo(L, FOOTER_TOP).lineTo(L + W, FOOTER_TOP).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
  doc.text(`Waves Pest Control, LLC · ${GUIDE_ADDRESS_LINE} · ${WAVES_SUPPORT_PHONE_DISPLAY} · ${WAVES_WEBSITE_HOST}`, L, FOOTER_TOP + 6, { width: W, align: 'center' });
  doc.text(WAVES_FL_LICENSE_LINE, L, FOOTER_TOP + 17, { width: W, align: 'center' });
  doc.page.margins.bottom = previousBottomMargin;
  doc.restore();
}

function ensureRoom(doc, needed) {
  if (doc.y + needed > CONTENT_BOTTOM) {
    footer(doc);
    doc.addPage();
    doc.y = 48;
  }
}

// Glass document-family header: navy bar (logo + contact) + soft title band —
// same construction as invoice-pdf's headerBar so every Waves document a
// customer downloads reads as one family.
function headerBar(doc, title) {
  doc.save();
  doc.rect(0, 0, PAGE_W, 92).fill(NAVY);
  const logoBuf = getLogoBuffer();
  if (logoBuf) {
    doc.image(logoBuf, 24, 10, { width: 72, height: 72 });
  } else {
    doc.fontSize(PDF_TYPE.display).font('Helvetica-Bold').fillColor(WHITE).text('WAVES', 40, 22);
    doc.fontSize(PDF_TYPE.caption).font('Helvetica').fillColor(HEADER_SUB).text('PEST CONTROL & LAWN CARE', 40, 52);
  }
  doc.fontSize(PDF_TYPE.micro).font('Helvetica').fillColor(HEADER_SUB).text(WAVES_FL_LICENSE_LINE, 108, 70);

  doc.fontSize(PDF_TYPE.body).font('Helvetica-Bold').fillColor(WHITE).text(WAVES_SUPPORT_PHONE_DISPLAY, 430, 22, { width: 142, align: 'right' });
  doc.fontSize(PDF_TYPE.micro).font('Helvetica').fillColor(HEADER_SUB).text(WAVES_WEBSITE_HOST, 430, 38, { width: 142, align: 'right' });
  doc.text('9040 Town Center Pkwy', 430, 52, { width: 142, align: 'right' });
  doc.text('Lakewood Ranch, FL 34202', 430, 64, { width: 142, align: 'right' });
  doc.restore();

  doc.save();
  doc.rect(0, 92, PAGE_W, 44).fill(SOFT);
  doc.fontSize(PDF_TYPE.h1).font('Helvetica').fillColor(NAVY).text(title, L, 104);
  doc.restore();
  doc.y = 152;
}

function sectionHeading(doc, text) {
  ensureRoom(doc, 46);
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(text, L, doc.y, { width: W });
  doc.moveDown(0.35);
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.moveDown(0.5);
}

function bullets(doc, items) {
  doc.font('Helvetica').fontSize(10).fillColor(BODY);
  for (const item of items) {
    ensureRoom(doc, 30);
    const y = doc.y;
    doc.circle(L + 4, y + 5, 1.6).fillColor(BLUE).fill();
    doc.fillColor(BODY).font('Helvetica').fontSize(10).text(item, L + 14, y, { width: W - 14, lineGap: 1.5 });
    doc.moveDown(0.35);
  }
}

function faqBlock(doc, faq) {
  for (const item of faq) {
    ensureRoom(doc, 56);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(item.q, L, doc.y, { width: W, lineGap: 1 });
    doc.moveDown(0.15);
    doc.font('Helvetica').fontSize(10).fillColor(BODY).text(item.a, L, doc.y, { width: W, lineGap: 1.5 });
    doc.moveDown(0.55);
  }
}

// Estimate-page CTA band — cream wash panel with the estimate's gold-pill
// button (theme-brand gold, navy text) so the guide hands the reader
// straight back to scheduling (owner 2026-07-10: "we don't want to lose
// them after they open the guide").
function ctaBand(doc, estimateUrl, micro) {
  if (!estimateUrl) return;
  ensureRoom(doc, 118);
  doc.moveDown(0.8);
  const top = doc.y;
  const H = 96;
  doc.save();
  doc.roundedRect(L, top, W, H, 10).fillColor(SOFT).fill();
  doc.roundedRect(L, top, W, H, 10).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY)
    .text('Ready? Pick your first visit in about a minute.', L, top + 12, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor(BODY)
    .text('Search by date or time — no calling, no hold music, no back-and-forth.', L, top + 30, { width: W, align: 'center' });

  // Gold pill button, centered — the whole pill is the link target.
  const label = 'Open your estimate & choose a time';
  doc.font('Helvetica-Bold').fontSize(11);
  const pillW = doc.widthOfString(label) + 44;
  const pillH = 26;
  const pillX = L + (W - pillW) / 2;
  const pillY = top + 46;
  doc.roundedRect(pillX, pillY, pillW, pillH, pillH / 2).fillColor(GOLD_PILL).fill();
  doc.fillColor(NAVY).text(label, pillX, pillY + 7, { width: pillW, align: 'center' });
  doc.link(pillX, pillY, pillW, pillH, estimateUrl);

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(micro || 'Month-to-month plan · Unlimited no-charge re-services for covered pests · 90-day money-back guarantee', L, top + H - 17, { width: W, align: 'center' });
  doc.restore();
  doc.y = top + H + 10;
}

// Page-1 "your system at a glance" box (termite): labeled rows in a soft
// panel — the single highest-transparency element in the guide.
function systemBox(doc, box) {
  if (!box || !Array.isArray(box.rows) || !box.rows.length) return;
  const padding = 12;
  const valueW = W - padding * 2 - 165;
  // Pre-measure: long values (covered-pest lists) wrap over several lines,
  // so row heights are measured, never assumed.
  doc.font('Helvetica').fontSize(9);
  const rowHeights = box.rows.map(([, value]) => Math.max(13, doc.heightOfString(String(value), { width: valueW, lineGap: 1 }) + 4));
  doc.font('Helvetica-Oblique').fontSize(8);
  const noteH = box.note ? doc.heightOfString(box.note, { width: W - padding * 2, lineGap: 1 }) + 8 : 0;
  const H = padding * 2 + 18 + rowHeights.reduce((a, b) => a + b, 0) + noteH;
  ensureRoom(doc, H + 16);
  doc.moveDown(0.6);
  const top = doc.y;
  doc.save();
  doc.roundedRect(L, top, W, H, 8).fillColor(SOFT).fill();
  doc.roundedRect(L, top, W, H, 8).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(box.heading || 'Your system at a glance', L + padding, top + padding);
  let y = top + padding + 18;
  box.rows.forEach(([label, value], i) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(label, L + padding, y, { width: 160 });
    doc.font('Helvetica').fontSize(9).fillColor(BODY).text(String(value), L + padding + 165, y, { width: valueW, lineGap: 1 });
    y += rowHeights[i];
  });
  if (box.note) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(box.note, L + padding, y + 4, { width: W - padding * 2, lineGap: 1 });
  }
  doc.restore();
  doc.y = top + H + 8;
}

// ── Vector illustrations (no photo assets needed) ──────────────────────────

// Florida treatment-notice sign in a lawn — pairs with the "why is there a
// sign in my yard" FAQ (statute-required posting, reframed as transparency).
function treatmentNoticeIllustration(doc) {
  const H = 130;
  ensureRoom(doc, H + 34);
  doc.moveDown(0.5);
  const top = doc.y;
  doc.save();
  // Scene panel
  doc.roundedRect(L, top, W, H, 8).fillColor('#F2F7F4').fill();
  doc.roundedRect(L, top, W, H, 8).lineWidth(0.75).strokeColor(RULE).stroke();
  // Lawn band
  doc.rect(L + 1, top + H - 34, W - 2, 33).fillColor('#7FB069').fill();
  doc.rect(L + 1, top + H - 34, W - 2, 6).fillColor('#8FBF78').fill();
  // Grass blades
  doc.lineWidth(1).strokeColor('#5E9150');
  for (let i = 0; i < 34; i++) {
    const gx = L + 14 + i * ((W - 28) / 34);
    doc.moveTo(gx, top + H - 30).lineTo(gx - 2, top + H - 40).stroke();
    doc.moveTo(gx + 3, top + H - 30).lineTo(gx + 5, top + H - 38).stroke();
  }
  // Sign stake
  const signCX = L + W / 2;
  doc.rect(signCX - 2, top + 58, 4, H - 92).fillColor('#8A8F98').fill();
  // Sign board (yellow, like FL posting signs)
  const bw = 150; const bh = 44;
  doc.roundedRect(signCX - bw / 2, top + 18, bw, bh, 4).fillColor('#FFD84D').fill();
  doc.roundedRect(signCX - bw / 2, top + 18, bw, bh, 4).lineWidth(1).strokeColor('#B8860B').stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1F2937')
    .text('PESTICIDE APPLICATION', signCX - bw / 2, top + 25, { width: bw, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor('#374151')
    .text('KEEP CHILDREN & PETS OFF', signCX - bw / 2, top + 37, { width: bw, align: 'center' });
  doc.text('UNTIL DRY', signCX - bw / 2, top + 46, { width: bw, align: 'center' });
  doc.restore();
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text('The state-required treatment notice we post at every qualifying visit — your digital report carries the full details.', L, top + H + 5, { width: W, align: 'center' });
  doc.y = top + H + 22;
}

// Numbered station-map SAMPLE for the termite guide — a stylized property,
// never a real one. The installation report carries the customer's actual map.
function stationMapIllustration(doc) {
  const H = 200;
  ensureRoom(doc, H + 36);
  doc.moveDown(0.5);
  const top = doc.y;
  doc.save();
  // Lot
  doc.roundedRect(L, top, W, H, 8).fillColor('#F4F8F2').fill();
  doc.roundedRect(L, top, W, H, 8).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('SAMPLE STATION MAP', L + 12, top + 10);
  // House footprint (L-shape) centered
  const hx = L + W / 2 - 90; const hy = top + 52; const hw = 180; const hh = 96;
  doc.save();
  doc.rect(hx, hy, hw, hh).fillColor('#FFFFFF').fill();
  doc.rect(hx + hw - 58, hy + hh - 40, 58, 40).fillColor('#F4F8F2').fill(); // garage notch
  doc.lineWidth(1.4).strokeColor(NAVY);
  doc.moveTo(hx, hy).lineTo(hx + hw, hy).lineTo(hx + hw, hy + hh - 40)
    .lineTo(hx + hw - 58, hy + hh - 40).lineTo(hx + hw - 58, hy + hh)
    .lineTo(hx, hy + hh).lineTo(hx, hy).stroke();
  doc.font('Helvetica').fontSize(8.5).fillColor(NAVY).text('HOME', hx, hy + hh / 2 - 6, { width: hw - 58, align: 'center' });
  doc.fontSize(7).text('GARAGE', hx + hw - 58, hy + hh - 40 + 14, { width: 58, align: 'center' });
  doc.restore();
  // Stations around the perimeter (offset outward)
  const o = 22;
  const pts = [
    [hx - o, hy - o], [hx + hw * 0.33, hy - o], [hx + hw * 0.66, hy - o], [hx + hw + o, hy - o],
    [hx + hw + o, hy + hh - 40 - 8], [hx + hw - 58 + o, hy + hh + o],
    [hx + hw * 0.38, hy + hh + o], [hx - o, hy + hh + o],
    [hx - o, hy + hh * 0.5],
  ];
  pts.forEach(([px, py], i) => {
    doc.circle(px, py, 8).fillColor(GOLD_PILL).fill();
    doc.circle(px, py, 8).lineWidth(1).strokeColor('#B8860B').stroke();
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY)
      .text(String(i + 1), px - 8, py - 3.5, { width: 16, align: 'center' });
  });
  // Legend
  doc.circle(L + 18, top + H - 16, 5).fillColor(GOLD_PILL).fill();
  doc.circle(L + 18, top + H - 16, 5).lineWidth(0.8).strokeColor('#B8860B').stroke();
  doc.font('Helvetica').fontSize(8).fillColor(BODY)
    .text('Trelona\u00ae bait station — numbered, mapped, checked quarterly', L + 28, top + H - 20);
  doc.restore();
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text('Illustration only — your installation report maps the actual numbered stations at your home, including any inaccessible perimeter sections.', L, top + H + 5, { width: W, align: 'center' });
  doc.y = top + H + 24;
}

const ILLUSTRATIONS = {
  treatment_notice: treatmentNoticeIllustration,
  station_map: stationMapIllustration,
};

function productBlock(doc, product) {
  const lines = [];
  if (product.active_ingredient) lines.push(['Active ingredient', product.active_ingredient]);
  if (product.epa_reg_number) lines.push(['EPA Reg. No.', product.epa_reg_number]);
  if (product.signal_word) lines.push(['Signal word', product.signal_word]);
  if (product.reentry_text) lines.push(['Re-entry guidance', product.reentry_text]);
  if (product.pet_kid_guidance_text) lines.push(['Pets & kids', product.pet_kid_guidance_text]);
  if (product.label_url) lines.push(['Product label', product.label_url]);
  if (product.sds_url) lines.push(['Safety data sheet', product.sds_url]);

  ensureRoom(doc, 60 + lines.length * 13);
  const title = product.common_name && product.common_name !== product.name
    ? `${product.name} (${product.common_name})`
    : product.name;
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(title, L, doc.y, { width: W });
  if (product.public_summary) {
    doc.font('Helvetica').fontSize(9.5).fillColor(BODY).text(product.public_summary, L, doc.y + 2, { width: W, lineGap: 1 });
  }
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  for (const [label, value] of lines) {
    ensureRoom(doc, 16);
    doc.font('Helvetica-Bold').fillColor(MUTED).text(`${label}: `, L + 10, doc.y, { width: W - 10, continued: true });
    doc.font('Helvetica').fillColor(BODY).text(String(value));
  }
  doc.moveDown(0.6);
}

// Documentation differentiators: bullets full-width, then a two-phone row —
// the service report and live GPS tracking screens from the app.
function documentationSection(doc, documentation) {
  sectionHeading(doc, documentation.heading);
  bullets(doc, documentation.bullets);

  const shots = [
    { buf: getAppShot('app-report.png'), caption: 'Your service report in the Waves app', ratio: 844 / 500 },
    { buf: getAppShot('app-track.png'), caption: 'Live technician tracking', ratio: 867 / 500 },
  ].filter((s) => s.buf);
  if (!shots.length) return;

  const shotW = 128;
  const gap = 36;
  const rowW = shots.length * shotW + (shots.length - 1) * gap;
  const maxH = Math.max(...shots.map((s) => Math.round(shotW * s.ratio)));
  ensureRoom(doc, maxH + 40);
  doc.moveDown(0.4);
  const top = doc.y;
  let x = L + (W - rowW) / 2;
  for (const s of shots) {
    const h = Math.round(shotW * s.ratio);
    try {
      doc.image(s.buf, x, top, { width: shotW });
      doc.save();
      doc.roundedRect(x, top, shotW, h, 8).lineWidth(0.75).strokeColor(RULE).stroke();
      doc.restore();
    } catch { /* asset optional */ }
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(s.caption, x - 12, top + maxH + 6, { width: shotW + 24, align: 'center' });
    x += shotW + gap;
  }
  doc.y = top + maxH + 22;
}

// Renders the guide; resolves with a Buffer.
function renderServiceDetailsPdf(content) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 48, bottom: 48, left: L, right: L } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    headerBar(doc, content.title);

    // Meta block — who this guide was prepared for, matching the estimate
    // page's contact block (name, email, phone, address, estimate #).
    doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY);
    if (content.customerName) doc.text(content.customerName, L, doc.y);
    doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
    if (content.customerEmail) doc.text(content.customerEmail, L, doc.y);
    if (content.customerPhone) doc.text(content.customerPhone, L, doc.y);
    if (content.address) doc.text(content.address, L, doc.y);
    if (content.estimateSlug) doc.fillColor(MUTED).fontSize(9).text(`Estimate #: ${content.estimateSlug}`, L, doc.y + 2);

    if (content.tagline) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text(content.tagline, L, doc.y, { width: W, lineGap: 1.5 });
    }

    if (content.systemBox) systemBox(doc, content.systemBox);

    sectionHeading(doc, "What's included");
    bullets(doc, content.included || []);

    sectionHeading(doc, 'How your visits work');
    bullets(doc, content.process || []);

    if (Array.isArray(content.faq) && content.faq.length) {
      sectionHeading(doc, 'The questions we hear most — answered straight');
      faqBlock(doc, content.faq);
    }

    for (const key of content.illustrations || []) {
      const draw = ILLUSTRATIONS[key];
      if (draw) draw(doc);
    }

    // Keep the estimate conversation going right after the answers
    // (guides that want a single CTA place it after the full picture).
    if (content.ctaPlacement !== 'closing_only') ctaBand(doc, content.estimateUrl, content.ctaMicro);

    if (content.documentation) documentationSection(doc, content.documentation);

    if (content.responsibilities) {
      sectionHeading(doc, content.responsibilities.heading);
      bullets(doc, content.responsibilities.bullets || []);
    }

    if (content.safety) {
      sectionHeading(doc, content.safety.heading);
      doc.font('Helvetica').fontSize(10).fillColor(BODY);
      for (const p of content.safety.paragraphs || []) {
        ensureRoom(doc, 44);
        doc.text(p, L, doc.y, { width: W, lineGap: 1.5 });
        doc.moveDown(0.5);
      }
      if (Array.isArray(content.safety.bullets) && content.safety.bullets.length) {
        doc.moveDown(0.2);
        bullets(doc, content.safety.bullets);
      }
      if (content.safety.closing) {
        ensureRoom(doc, 50);
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY)
          .text(content.safety.closing, L, doc.y, { width: W, lineGap: 1.5 });
        doc.moveDown(0.4);
      }
    }

    if (content.compliance && Array.isArray(content.compliance.bullets) && content.compliance.bullets.length) {
      sectionHeading(doc, content.compliance.heading || 'Compliance & licensing');
      bullets(doc, content.compliance.bullets);
    }

    if (content.productImages) productImageRow(doc, content.productImages);

    sectionHeading(doc, 'Products we may use');
    if (Array.isArray(content.products) && content.products.length) {
      doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
        .text('Product selection varies by pest, property, season, and treatment area — not every listed product is applied at every property. Your service report identifies the exact products used during your visit. Every pesticide product below is EPA-registered and applied per its label.', L, doc.y, { width: W, lineGap: 1 });
      doc.moveDown(0.6);
      for (const product of content.products) productBlock(doc, product);
    } else {
      doc.font('Helvetica').fontSize(10).fillColor(BODY).text(
        `Product selection is matched to your property at service time. For the current product list — including labels and safety data sheets — visit ${WAVES_WEBSITE_HOST}/products-and-safety/ or ask us any time.`,
        L, doc.y, { width: W, lineGap: 1.5 },
      );
    }

    // Closing CTA — after the full picture (coverage, safety, products).
    ctaBand(doc, content.estimateUrl, content.ctaMicro);

    doc.moveDown(0.4);
    ensureRoom(doc, 40);
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(
      `Questions about anything in this guide? Reply to the message that delivered it, or call ${WAVES_SUPPORT_PHONE_DISPLAY} — you'll get a straight answer.`,
      L, doc.y, { width: W, lineGap: 1.5 },
    );

    footer(doc);
    doc.end();
  });
}

module.exports = { renderServiceDetailsPdf };
