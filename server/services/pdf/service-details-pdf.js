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
  doc.text(`Waves Pest Control, LLC · ${WAVES_ADDRESS_LINE} · ${WAVES_SUPPORT_PHONE_DISPLAY} · ${WAVES_WEBSITE_HOST}`, L, FOOTER_TOP + 6, { width: W, align: 'center' });
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
  doc.text('13649 Luxe Ave #110', 430, 52, { width: 142, align: 'right' });
  doc.text('Bradenton, FL 34211', 430, 64, { width: 142, align: 'right' });
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
    .text(micro || 'No long-term contract · Unlimited free callbacks · 90-day money-back guarantee', L, top + H - 17, { width: W, align: 'center' });
  doc.restore();
  doc.y = top + H + 10;
}

// Page-1 "your system at a glance" box (termite): labeled rows in a soft
// panel — the single highest-transparency element in the guide.
function systemBox(doc, box) {
  if (!box || !Array.isArray(box.rows) || !box.rows.length) return;
  const rowH = 16;
  const padding = 12;
  const noteH = box.note ? 30 : 0;
  const H = padding * 2 + 18 + box.rows.length * rowH + noteH;
  ensureRoom(doc, H + 16);
  doc.moveDown(0.6);
  const top = doc.y;
  doc.save();
  doc.roundedRect(L, top, W, H, 8).fillColor(SOFT).fill();
  doc.roundedRect(L, top, W, H, 8).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(box.heading || 'Your system at a glance', L + padding, top + padding);
  let y = top + padding + 18;
  for (const [label, value] of box.rows) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(label, L + padding, y, { width: 160 });
    doc.font('Helvetica').fontSize(9).fillColor(BODY).text(String(value), L + padding + 165, y, { width: W - padding * 2 - 165 });
    y += rowH;
  }
  if (box.note) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(box.note, L + padding, y + 2, { width: W - padding * 2, lineGap: 1 });
  }
  doc.restore();
  doc.y = top + H + 8;
}

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
