// ============================================================
// termite-comparison-pdf.js — termite protection options sheet
//
// One page: buy-vs-rent the bait stations side by side (both columns priced
// by the engine for THIS property), the bond term menu when the bond gate
// has emitted options, and an honest framing of the trade — $0 up front
// versus cheaper over time. Content assembly lives in
// services/termite-warranty-comparison.js; this file is presentation only.
//
// Chrome follows the unified glass document family (doc-style unify #2543):
// pdf-tokens palette, the same navy header bar + soft title band as
// invoice-pdf / service-details-pdf, gold-pill CTA back to the estimate.
//
// Copy rules carried by hand (there is no automated gate on document copy):
// pricing is "per application", never "per visit"; no safety claims of any
// kind on this sheet (pricing/ownership only); no competitor names; the
// rental is a rental rate, not a payment plan, and the sheet says so.
// ============================================================

const PDFDocument = require('pdfkit');
const { getLogoBuffer } = require('./brand-logo');
const { PDF_COLORS, PDF_TYPE } = require('./pdf-tokens');
const {
  WAVES_WEBSITE_HOST,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_FL_LICENSE_LINE,
} = require('../../constants/business');

const NAVY = PDF_COLORS.navy;
const BLUE = PDF_COLORS.blue;
const BODY = PDF_COLORS.body;
const MUTED = PDF_COLORS.muted;
const RULE = PDF_COLORS.rule;
const SOFT = PDF_COLORS.soft;
const HEADER_SUB = PDF_COLORS.headerSub;
const WHITE = PDF_COLORS.white;
const GOLD_PILL = '#FFD700';

const PAGE_W = 612;
const L = 40;
const W = PAGE_W - 80;
const FOOTER_TOP = 742;
const CONTENT_BOTTOM = FOOTER_TOP - 24;

// Same headquarters line as the other global customer guides
// (2026-07-11 publishing rule).
const GUIDE_ADDRESS_LINE = '9040 Town Center Pkwy, Lakewood Ranch, FL 34202';

const money = (n) => `$${Number(n).toLocaleString('en-US', {
  minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2,
  maximumFractionDigits: 2,
})}`;

// Human wording for the rent-vs-buy crossover horizon. Whole quarters below
// a year, decimal years above (codex P2: rounding to whole years turned a
// 1-quarter horizon into "the first 0 years" and 2 quarters into a year).
function crossoverText(quarters) {
  const q = Number(quarters);
  if (!Number.isFinite(q) || q <= 0) return 'the recovery period';
  if (q === 1) return 'the first quarter';
  if (q < 4) return `the first ${q} quarters`;
  const years = Math.round((q / 4) * 10) / 10;
  return `the first ${years} year${years === 1 ? '' : 's'}`;
}

function footer(doc) {
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
  doc.y = 148;
}

function sectionHeading(doc, text) {
  ensureRoom(doc, 42);
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(text, L, doc.y, { width: W });
  doc.moveDown(0.35);
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.moveDown(0.4);
}

// Two-option comparison panel: label column + Buy column + Rent column,
// heights measured per row (values wrap), soft panel like systemBox.
function comparisonTable(doc, rows) {
  const padding = 12;
  const labelW = 150;
  const colGap = 10;
  const colW = (W - padding * 2 - labelW - colGap * 2) / 2;
  const colX = (i) => L + padding + labelW + colGap + i * (colW + colGap);

  doc.font('Helvetica').fontSize(9.5);
  const rowHeights = rows.map(([, a, b]) => {
    const ha = doc.heightOfString(String(a), { width: colW, lineGap: 1 });
    const hb = doc.heightOfString(String(b), { width: colW, lineGap: 1 });
    return Math.max(14, ha + 5, hb + 5);
  });
  const headH = 18;
  const H = padding * 2 + headH + rowHeights.reduce((a, b) => a + b, 0);
  ensureRoom(doc, H + 16);
  doc.moveDown(0.4);
  const top = doc.y;
  doc.save();
  doc.roundedRect(L, top, W, H, 8).fillColor(SOFT).fill();
  doc.roundedRect(L, top, W, H, 8).lineWidth(0.75).strokeColor(RULE).stroke();

  // Column headers
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY);
  doc.text('Buy the stations', colX(0), top + padding, { width: colW });
  doc.text('Rent the stations', colX(1), top + padding, { width: colW });

  let y = top + padding + headH;
  rows.forEach(([label, a, b], i) => {
    if (i > 0) {
      doc.moveTo(L + padding, y - 3).lineTo(L + W - padding, y - 3).lineWidth(0.5).strokeColor(RULE).stroke();
    }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(label, L + padding, y, { width: labelW - 6, lineGap: 1 });
    doc.font('Helvetica').fontSize(9.5).fillColor(BODY).text(String(a), colX(0), y, { width: colW, lineGap: 1 });
    doc.font('Helvetica').fontSize(9.5).fillColor(BODY).text(String(b), colX(1), y, { width: colW, lineGap: 1 });
    y += rowHeights[i];
  });
  doc.restore();
  doc.y = top + H + 8;
}

function noteParagraph(doc, text) {
  ensureRoom(doc, 40);
  doc.moveDown(0.2);
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(text, L, doc.y, { width: W, lineGap: 1.3 });
  doc.moveDown(0.25);
}

function bullets(doc, items) {
  doc.font('Helvetica').fontSize(9.5).fillColor(BODY);
  for (const item of items) {
    ensureRoom(doc, 30);
    const y = doc.y;
    doc.circle(L + 4, y + 5, 1.6).fillColor(BLUE).fill();
    doc.fillColor(BODY).font('Helvetica').fontSize(9.5).text(item, L + 14, y, { width: W - 14, lineGap: 1.2 });
    doc.moveDown(0.25);
  }
}

function ctaBand(doc, estimateUrl) {
  if (!estimateUrl) return;
  // The band is always the LAST element, so it may run right up to the
  // footer rule instead of ensureRoom's conservative content bound — that
  // margin exists to keep body text off the footer, not a closing panel.
  if (doc.y + 95 > FOOTER_TOP - 6) {
    footer(doc);
    doc.addPage();
    doc.y = 48;
  }
  doc.moveDown(0.3);
  const top = doc.y;
  const H = 88;
  doc.save();
  doc.roundedRect(L, top, W, H, 10).fillColor(SOFT).fill();
  doc.roundedRect(L, top, W, H, 10).lineWidth(0.75).strokeColor(RULE).stroke();
  // Copy promises only actions the estimate page actually offers (codex P1):
  // scheduling as quoted and asking us a question live there; switching
  // station ownership is a re-quote WE make — say so, don't imply a toggle.
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor(NAVY)
    .text('Happy with your option? Schedule from your estimate. Want the other one? Just ask — we’ll re-quote it, no obligation.', L, top + 9, { width: W, align: 'center' });

  const label = 'Open your estimate';
  doc.font('Helvetica-Bold').fontSize(11);
  const pillW = doc.widthOfString(label) + 44;
  const pillH = 26;
  const pillX = L + (W - pillW) / 2;
  const pillY = top + 42;
  doc.roundedRect(pillX, pillY, pillW, pillH, pillH / 2).fillColor(GOLD_PILL).fill();
  doc.fillColor(NAVY).text(label, pillX, pillY + 7, { width: pillW, align: 'center' });
  doc.link(pillX, pillY, pillW, pillH, estimateUrl);

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(`Priced for your home · No obligation · Questions? Call or text ${WAVES_SUPPORT_PHONE_DISPLAY}`, L, top + H - 15, { width: W, align: 'center' });
  doc.restore();
  doc.y = top + H + 10;
}

// content = buildTermiteComparisonData(...) result plus
// { customerName, address, estimateUrl }.
function renderTermiteComparisonPdf(content) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', margins: { top: 48, bottom: 48, left: L, right: L } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    headerBar(doc, 'Termite Protection — Your Options');

    const { own, rent, bondOptions = [], visitsPerYear = 4 } = content;
    const intro = [
      content.address ? `Priced for ${content.address}.` : 'Priced for your home.',
      content.stations
        ? `Your program: ${content.stations} in-ground bait stations, checked ${visitsPerYear} times a year on a quarterly station check, billed per application.`
        : `Your program: in-ground bait stations, checked ${visitsPerYear} times a year on a quarterly station check, billed per application.`,
      'Same stations, same bait, same quarterly checks either way — the difference is who owns the hardware and how you pay.',
    ].join(' ');
    doc.font('Helvetica').fontSize(10).fillColor(BODY).text(intro, L, doc.y, { width: W, lineGap: 1.5 });
    doc.moveDown(0.4);

    sectionHeading(doc, 'Own the stations, or rent them?');
    comparisonTable(doc, [
      ['Due at installation', money(own.installToday), `$0 — ${money(rent.hardwareValue)} of hardware installed at no charge`],
      ['Per application (quarterly)', money(own.perApp), `${money(rent.perApp)} (${money(rent.basePerApp)} station check + ${money(rent.upliftPerApp)} station rental)`],
      ['Who owns the hardware', 'You do — bought once, yours permanently.', 'Waves — we retain ownership.'],
      ['If you end the program', 'The stations stay in your yard.', 'We remove the stations; your inspection history stays in your app.'],
    ]);
    noteParagraph(doc,
      `Straight talk: renting costs nothing up front but is not a payment plan — the rental charge is a fixed rate that continues for as long as the program runs. The two options cost about the same over ${crossoverText(rent.recoveryQuarters || 20)}; past that point, owning costs less. Renting is the right fit for starting at $0 today; buying is the right fit for the long haul.`);

    if (bondOptions.length) {
      sectionHeading(doc, 'Add a warranty: the termite bond');
      // The rate-ordering claim is DERIVED from the actual snapshot (codex
      // P2): a valid-but-non-monotonic bond config must not ship a sheet
      // promising "longer terms are cheaper" over rows showing the opposite.
      const ratesDescendWithTerm = bondOptions.every(
        (opt, i, all) => i === 0 || opt.perApp <= all[i - 1].perApp,
      );
      doc.font('Helvetica').fontSize(10).fillColor(BODY).text(
        ratesDescendWithTerm
          ? 'Either ownership option can carry a termite bond — a repair warranty that rides the same quarterly station check. Pick the term on your estimate; longer terms lock a lower per-application rate, fixed for the term you pick.'
          : 'Either ownership option can carry a termite bond — a repair warranty that rides the same quarterly station check. Pick the term on your estimate; each term’s per-application rate is fixed for the term you pick.',
        L, doc.y, { width: W, lineGap: 1.5 },
      );
      doc.moveDown(0.4);
      bullets(doc, [
        ...bondOptions.map((opt) => `${opt.label} term — adds ${money(opt.perApp)} per application`),
        'Repair coverage up to $1,000,000 for new covered WDO damage.',
        'Transferable to a new homeowner ($250 + transfer inspection) — the buyer inherits active termite protection with its documented history.',
      ]);
      noteParagraph(doc, 'Your signed termite agreement controls the covered structures, covered organisms, warranty type, renewal, limitations, and exclusions.');
    }

    ctaBand(doc, content.estimateUrl);
    footer(doc);
    doc.end();
  });
}

module.exports = { renderTermiteComparisonPdf, crossoverText };
