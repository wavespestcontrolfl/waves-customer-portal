// ============================================================
// estimate-pdf.js — Commercial proposal PDF
//
// Renders a formal, branded multi-building line-item proposal for a
// commercial estimate (e.g. an HOA with two towers + N lake houses). Built
// on pdfkit, mirroring the header/footer/table chrome of invoice-pdf.js so
// the document family stays visually consistent.
//
// Data shape comes from services/estimate-proposal.js (normalizeProposal +
// computeProposalTotals). This file is presentation only — no pricing or
// tax business logic lives here.
// ============================================================

const PDFDocument = require('pdfkit');
const { getLogoBuffer } = require('./brand-logo');
const {
  WAVES_ADDRESS_LINE,
  WAVES_WEBSITE_HOST,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_FL_LICENSE_LINE,
  WAVES_FDACS_LICENSE_NUMBER,
} = require('../../constants/business');
const { formatDisplayDate } = require('../../utils/date-only');
const { normalizeProposal, computeProposalTotals } = require('../estimate-proposal');

// Brand palette — identical to invoice-pdf.js.
const NAVY = '#1B2C5B';
const WAVES_BLUE = '#009CDE';
const GREEN = '#047857';
const INK = NAVY;
const BODY = '#3F4A65';
const MUTED = '#6B7280';
const RULE = '#E7E2D7';
const SOFT = '#FAF8F3';

const PAGE_W = 612;
const L = 40;            // left margin
const W = PAGE_W - 80;   // content width
const FOOTER_TOP = 742;
const CONTENT_BOTTOM = FOOTER_TOP - 18;  // last y a row may occupy

const safeFilename = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'waves';

function currency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function headerBar(doc, title, statusLabel, statusColor) {
  doc.save();
  doc.rect(0, 0, PAGE_W, 92).fill(NAVY);

  const logoBuf = getLogoBuffer();
  if (logoBuf) {
    doc.image(logoBuf, 24, 10, { width: 72, height: 72 });
  } else {
    doc.fontSize(26).font('Helvetica-Bold').fillColor('#fff').text('WAVES', 40, 22);
    doc.fontSize(9).font('Helvetica').fillColor('#B8D4EA').text('PEST CONTROL & LAWN CARE', 40, 52);
  }
  doc.fontSize(8).font('Helvetica').fillColor('#B8D4EA').text(WAVES_FL_LICENSE_LINE, 108, 70);

  doc.fontSize(10).font('Helvetica-Bold').fillColor('#fff').text(WAVES_SUPPORT_PHONE_DISPLAY, 430, 22, { width: 142, align: 'right' });
  doc.fontSize(8).font('Helvetica').fillColor('#B8D4EA').text(WAVES_WEBSITE_HOST, 430, 38, { width: 142, align: 'right' });
  doc.text('13649 Luxe Ave #110', 430, 52, { width: 142, align: 'right' });
  doc.text('Bradenton, FL 34211', 430, 64, { width: 142, align: 'right' });
  doc.restore();

  doc.save();
  doc.rect(0, 92, PAGE_W, 44).fill(SOFT);
  doc.fontSize(20).font('Helvetica').fillColor(NAVY).text(title, 40, 104, { width: 420 });

  if (statusLabel) {
    const badgeW = doc.widthOfString(statusLabel) + 20;
    doc.roundedRect(PAGE_W - 40 - badgeW, 105, badgeW, 22, 11).fill(statusColor);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff')
      .text(statusLabel.toUpperCase(), PAGE_W - 40 - badgeW + 10, 111);
  }
  doc.restore();
}

// Slim continuation header for pages 2+ so a long multi-building proposal
// stays branded without re-printing the full masthead.
function continuationHeader(doc, title) {
  doc.save();
  doc.rect(0, 0, PAGE_W, 40).fill(NAVY);
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#fff').text('WAVES', 40, 13);
  doc.fontSize(9).font('Helvetica').fillColor('#B8D4EA').text(title, 120, 15, { width: 452, align: 'right' });
  doc.restore();
}

function footerBar(doc, tagline) {
  const previousBottomMargin = doc.page.margins.bottom;
  doc.save();
  doc.page.margins.bottom = 0;
  doc.rect(0, FOOTER_TOP, PAGE_W, 50).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(
    tagline || 'Thank you for considering Waves',
    0, FOOTER_TOP + 10, { width: PAGE_W, align: 'center' },
  );
  doc.fontSize(7).font('Helvetica').fillColor('#B8D4EA').text(
    `Waves Pest Control, LLC · FDACS #${WAVES_FDACS_LICENSE_NUMBER} · ${WAVES_ADDRESS_LINE} · ${WAVES_SUPPORT_PHONE_DISPLAY} · ${WAVES_WEBSITE_HOST}`,
    0, FOOTER_TOP + 26, { width: PAGE_W, align: 'center' },
  );
  doc.page.margins.bottom = previousBottomMargin;
  doc.restore();
}

function sectionLabel(doc, label, x, y) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
    .text(label.toUpperCase(), x, y, { characterSpacing: 1.2 });
  return y + 14;
}

// Page-break guard. Returns a y that is guaranteed to have `needed` px of
// room before the footer; adds a continuation page (and footer on the page
// we're leaving) when it doesn't.
function ensureSpace(ctx, y, needed) {
  if (y + needed <= CONTENT_BOTTOM) return y;
  footerBar(ctx.doc, ctx.tagline);
  ctx.doc.addPage();
  continuationHeader(ctx.doc, ctx.title);
  return 56;
}

function metaBlock(doc, estimate, proposal, x, y) {
  y = sectionLabel(doc, 'Prepared for', x, y);
  doc.fontSize(12).font('Helvetica-Bold').fillColor(INK)
    .text(proposal.preparedFor || '—', x, y, { width: W / 2 - 20 });
  y += 16;
  if (proposal.propertyAddress) {
    doc.fontSize(10).font('Helvetica').fillColor(BODY)
      .text(proposal.propertyAddress, x, y, { width: W / 2 - 20 });
    y += doc.heightOfString(proposal.propertyAddress, { width: W / 2 - 20 }) + 2;
  }
  if (estimate.customer_email) {
    doc.fontSize(10).font('Helvetica').fillColor(BODY).text(estimate.customer_email, x, y);
    y += 12;
  }
  return y;
}

function detailsBlock(doc, estimate, x, y) {
  y = sectionLabel(doc, 'Proposal details', x, y);
  const rows = [
    ['Proposal #', String(estimate.id || '').split('-')[0].toUpperCase() || '—'],
    ['Date', formatDisplayDate(estimate.created_at || new Date(), { fallback: '—' })],
    ['Valid through', formatDisplayDate(estimate.expires_at, { fallback: '30 days from issue' })],
    ['Prepared by', 'Waves Pest Control, LLC'],
  ];
  doc.fontSize(10).font('Helvetica');
  for (const [label, value] of rows) {
    doc.fillColor(MUTED).text(label, x, y, { width: 90 });
    doc.fillColor(INK).text(String(value), x + 90, y, { width: 150 });
    y += 14;
  }
  return y;
}

// Column geometry for the line-item table.
const COL = {
  desc: L,
  freq: L + W - 250,
  qty: L + W - 165,
  rate: L + W - 130,
  amount: L + W - 70,
};
const COL_W = { desc: W - 260, freq: 80, qty: 30, rate: 60, amount: 70 };

function tableHeader(doc, y) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED);
  doc.text('DESCRIPTION', COL.desc, y, { width: COL_W.desc, characterSpacing: 1 });
  doc.text('CADENCE', COL.freq, y, { width: COL_W.freq, characterSpacing: 1 });
  doc.text('QTY', COL.qty, y, { width: COL_W.qty, align: 'right', characterSpacing: 1 });
  doc.text('RATE', COL.rate, y, { width: COL_W.rate, align: 'right', characterSpacing: 1 });
  doc.text('AMOUNT', COL.amount, y, { width: COL_W.amount, align: 'right', characterSpacing: 1 });
  y += 13;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor(RULE).stroke();
  return y + 6;
}

function buildingBlock(ctx, building, y, taxRate) {
  const { doc } = ctx;
  // Keep the building heading + table header + first row together.
  y = ensureSpace(ctx, y, 64);

  // Building heading bar
  doc.save();
  doc.rect(L, y, W, 22).fill(SOFT);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(NAVY).text(building.name, L + 10, y + 6, { width: W - 20 });
  doc.restore();
  y += 30;

  if (building.note) {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor(MUTED).text(building.note, L, y, { width: W });
    y += doc.heightOfString(building.note, { width: W }) + 4;
  }

  y = tableHeader(doc, y);

  let buildingAnnual = 0;
  let buildingOneTime = 0;

  doc.fontSize(10);
  for (const item of building.lineItems) {
    const descH = doc.heightOfString(item.description || '—', { width: COL_W.desc });
    const rowH = Math.max(descH + 6, 18);
    y = ensureSpace(ctx, y, rowH + 4);
    if (y === 56) y = tableHeader(doc, y);  // re-print header after a page break

    doc.font('Helvetica').fillColor(INK).text(item.description || '—', COL.desc, y, { width: COL_W.desc });
    doc.fillColor(BODY).fontSize(9).text(item.frequencyLabel, COL.freq, y + 1, { width: COL_W.freq });
    doc.fontSize(10).fillColor(INK);
    doc.text(String(item.quantity), COL.qty, y, { width: COL_W.qty, align: 'right' });
    doc.text(currency(item.unitPrice), COL.rate, y, { width: COL_W.rate, align: 'right' });
    const amountLabel = currency(item.amount) + (item.taxable ? ' *' : '');
    doc.text(amountLabel, COL.amount, y, { width: COL_W.amount, align: 'right' });
    y += rowH;

    if (item.frequency === 'one_time') buildingOneTime += item.amount;
    else buildingAnnual += item.amount * ({ monthly: 12, bimonthly: 6, quarterly: 4, annual: 1 }[item.frequency] || 0);
  }

  // Building subtotal line
  y += 2;
  doc.moveTo(COL.rate - 10, y).lineTo(L + W, y).lineWidth(0.5).strokeColor(RULE).stroke();
  y += 6;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(MUTED);
  const subtotalParts = [];
  if (buildingAnnual > 0) subtotalParts.push(`${currency(buildingAnnual)}/yr recurring`);
  if (buildingOneTime > 0) subtotalParts.push(`${currency(buildingOneTime)} one-time`);
  doc.text(
    subtotalParts.length ? `Subtotal — ${subtotalParts.join(' + ')}` : 'Subtotal — included',
    L, y, { width: W, align: 'right' },
  );
  y += 22;
  return y;
}

function totalsBlock(ctx, totals, y) {
  const { doc } = ctx;
  y = ensureSpace(ctx, y, 140);

  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1).strokeColor(NAVY).stroke();
  y += 12;

  const labelX = L + W - 280;
  const valueX = L + W - 90;
  const row = (label, value, opts = {}) => {
    const { bold = false, color = BODY, size = 10 } = opts;
    doc.fontSize(size).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color);
    doc.text(label, labelX, y, { width: 190, align: 'right' });
    doc.text(value, valueX, y, { width: 90, align: 'right' });
    y += size + 6;
  };

  if (totals.annualRecurring > 0) {
    row('Recurring (monthly equivalent)', `${currency(totals.monthlyEquivalent)}/mo`);
    row('Recurring (annualized)', `${currency(totals.annualRecurring)}/yr`);
  }
  if (totals.oneTime > 0) row('One-time services', currency(totals.oneTime));
  if (totals.hasTax) {
    row(`${ctx.taxLabel} (${(totals.taxRate * 100).toFixed(2)}%)`, currency(totals.totalTax));
  }

  y += 2;
  doc.moveTo(labelX - 10, y).lineTo(L + W, y).lineWidth(0.5).strokeColor(RULE).stroke();
  y += 8;
  doc.fontSize(13).font('Helvetica-Bold').fillColor(NAVY);
  doc.text('FIRST-YEAR TOTAL', labelX, y, { width: 190, align: 'right', characterSpacing: 1 });
  doc.text(currency(totals.firstYearTotal), valueX, y, { width: 90, align: 'right' });
  y += 22;

  return y;
}

function termsBlock(ctx, proposal, totals, y) {
  const { doc } = ctx;
  const lines = [];
  if (totals.hasTax || (proposal.buildings || []).some((b) => b.lineItems.some((i) => i.taxable))) {
    lines.push('* Taxable line. Residential HOA pest service and all lawn care are non-taxable in Florida; tax applies only to genuinely taxable lines at the county-keyed rate.');
  }
  lines.push(`Licensed & insured — Florida FDACS #${WAVES_FDACS_LICENSE_NUMBER}. Certificate of Insurance available on request.`);
  lines.push('Integrated Pest Management (IPM) program with documented service records and a callback guarantee between scheduled visits.');
  if (proposal.terms) lines.push(proposal.terms);

  y = ensureSpace(ctx, y, 30 + lines.length * 26);
  y = sectionLabel(doc, 'Terms & assurances', L, y);
  doc.fontSize(9).font('Helvetica').fillColor(BODY);
  for (const line of lines) {
    doc.text(line, L, y, { width: W, lineGap: 1.5 });
    y += doc.heightOfString(line, { width: W, lineGap: 1.5 }) + 6;
  }
  return y;
}

function generateEstimateProposalPDF(estimate, res) {
  const proposal = normalizeProposal(estimate);
  const totals = computeProposalTotals(proposal);

  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
  const fileName = `proposal-${safeFilename(proposal.preparedFor || estimate.id)}.pdf`;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  }
  doc.pipe(res);

  const ctx = {
    doc,
    title: proposal.title,
    taxLabel: proposal.taxLabel,
    tagline: 'Thank you for considering Waves Pest Control',
  };

  headerBar(doc, proposal.title, totals.isMultiBuilding ? 'Commercial' : 'Proposal', WAVES_BLUE);

  let yLeft = 160;
  let yRight = 160;
  yLeft = metaBlock(doc, estimate, proposal, L, yLeft);
  yRight = detailsBlock(doc, estimate, L + W / 2 + 20, yRight);
  let y = Math.max(yLeft, yRight) + 18;

  for (const building of proposal.buildings) {
    y = buildingBlock(ctx, building, y, proposal.taxRate);
  }

  y = totalsBlock(ctx, totals, y + 4);
  y = termsBlock(ctx, proposal, totals, y + 8);

  footerBar(doc, ctx.tagline);
  doc.end();
}

function streamToBuffer(streamFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = {
      setHeader() {},
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve(Buffer.concat(chunks));
      },
      on() {}, once() {}, emit() {},
    };
    try { streamFn(sink); } catch (err) { reject(err); }
  });
}

async function buildEstimateProposalPDFBuffer(estimate) {
  return streamToBuffer((sink) => generateEstimateProposalPDF(estimate, sink));
}

// SendGrid / EmailTemplateLibrary attachment shape (base64 content).
async function buildEstimateProposalEmailAttachment(estimate) {
  const proposal = normalizeProposal(estimate);
  const buffer = await buildEstimateProposalPDFBuffer(estimate);
  return {
    filename: `Waves-Proposal-${safeFilename(proposal.preparedFor || estimate.id)}.pdf`,
    content: buffer.toString('base64'),
    type: 'application/pdf',
    disposition: 'attachment',
  };
}

module.exports = {
  generateEstimateProposalPDF,
  buildEstimateProposalPDFBuffer,
  buildEstimateProposalEmailAttachment,
};
