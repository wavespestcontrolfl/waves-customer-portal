// ============================================================
// estimate-doc-pdf.js — browser-rendered estimate document
//
// Renders the React EstimateProposalDocument (the work-order style
// document, modeled on the service-report pipeline) by driving a headless
// browser to /estimate/:token?mode=pdf, exactly like
// service-report/pdf-puppeteer.js drives /report/:token?mode=pdf.
//
// Gate: GATE_ESTIMATE_DOC_PDF (config/feature-gates.js `estimateDocPdf`).
// Every caller keeps the legacy pdfkit generator (estimate-pdf.js) as its
// fallback — a browser failure must never block an estimate download or a
// proposal email. The gate check itself lives at the call sites so this
// module stays a pure renderer.
//
// The valid-through pin: the send path emails the PDF with an expires_at
// the DB row does not carry yet (nextExpiresAt persists AFTER the
// attachment is built — admin-estimates.js send flow), so the render URL
// can carry a SIGNED display override. /:token/data verifies the pin and
// swaps the advertised expiresAt; an unsigned/invalid pin is ignored (the
// document then shows the stored date — never a caller-chosen one).
// Same trust pattern as the service-report assessment pin.
// ============================================================

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const logger = require('../logger');
const { launchBrowser, serviceReportPublicBase } = require('../service-report/pdf-puppeteer');

const DOC_PIN_TTL_SECONDS = 15 * 60;

function docPinSecret() {
  return process.env.ESTIMATE_DOC_PIN_SECRET || process.env.JWT_SECRET || null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

// Signed render pin — EVERY server-driven document render carries one. Two
// jobs: (1) it authenticates the render pass to /:token/data, which only
// suppresses view side effects (view_count / viewed_at / notifications /
// engagement) for a VERIFIED pin — a bare public ?mode=pdf renders the
// document but still counts as the customer view it is; (2) it optionally
// carries the valid-through display override for the send path.
function signEstimateDocPin(token, { validThrough = null } = {}) {
  const secret = docPinSecret();
  if (!secret) return null;
  let vexp;
  if (validThrough != null) {
    const millis = validThrough instanceof Date ? validThrough.getTime() : Date.parse(String(validThrough));
    if (Number.isNaN(millis)) return null;
    vexp = new Date(millis).toISOString();
  }
  return jwt.sign(
    { kind: 'estimate_doc_render', tokenHash: hashToken(token), ...(vexp ? { vexp } : {}) },
    secret,
    { expiresIn: DOC_PIN_TTL_SECONDS },
  );
}

// Verifies a pin against the estimate token it claims to describe.
// Returns { validThrough: string|null } for a verified render pin, or null —
// callers treat null as "unauthenticated render" (side effects fire), never
// as an error.
function verifyEstimateDocPin(pin, token) {
  const secret = docPinSecret();
  if (!secret || !pin) return null;
  try {
    const payload = jwt.verify(String(pin), secret);
    if (payload?.kind !== 'estimate_doc_render') return null;
    if (payload.tokenHash !== hashToken(token)) return null;
    if (payload.vexp != null && Number.isNaN(Date.parse(payload.vexp))) return null;
    return { validThrough: payload.vexp || null };
  } catch {
    return null;
  }
}

function estimateDocumentUrl(token, { validThrough = null } = {}) {
  const base = serviceReportPublicBase(null).replace(/\/+$/, '');
  const pin = signEstimateDocPin(token, { validThrough });
  if (!pin) {
    // FAIL CLOSED (same trade as the service-report assessment pin): an
    // unpinned server render would fire the estimate's view side effects —
    // stamping viewed_at and pinging "Estimate viewed" from an attachment
    // build. Throwing routes every caller onto the pdfkit fallback instead.
    // A missing JWT_SECRET would already have broken auth app-wide, so this
    // is not a realistic silent-degradation path.
    const err = new Error('estimate doc render pin cannot be signed — set ESTIMATE_DOC_PIN_SECRET or JWT_SECRET');
    err.code = 'estimate_doc_pin_unsignable';
    throw err;
  }
  return `${base}/estimate/${encodeURIComponent(token)}?mode=pdf&dpin=${encodeURIComponent(pin)}`;
}

// Bounded render concurrency — every render launches a Chromium process,
// and the public /:token/pdf route is reachable by any token holder. The
// per-IP route limiter can be bypassed by distributed callers, so this
// in-process semaphore is the real backstop: past the cap, renders throw
// `estimate_doc_render_busy` and every caller serves its pdfkit fallback
// instead of stacking browsers until Railway runs out of memory.
const MAX_CONCURRENT_DOC_RENDERS = Math.max(1, Number(process.env.ESTIMATE_DOC_PDF_MAX_CONCURRENT || 2));
let activeDocRenders = 0;

// Renders the document → Buffer. Throws on any failure; callers fall back
// to the pdfkit generator. Mirrors renderReportPdfWithBrowser's settings
// (Letter, print media, 0.5in margins, page-number footer).
async function renderEstimateDocumentPdf(estimate, { validThrough = null } = {}) {
  if (!estimate?.token) throw new Error('estimate token required for document render');
  if (activeDocRenders >= MAX_CONCURRENT_DOC_RENDERS) {
    const busy = new Error(`estimate document render capacity reached (${MAX_CONCURRENT_DOC_RENDERS} concurrent)`);
    busy.code = 'estimate_doc_render_busy';
    throw busy;
  }
  activeDocRenders += 1;
  try {
    return await renderEstimateDocumentPdfInner(estimate, { validThrough });
  } finally {
    activeDocRenders -= 1;
  }
}

async function renderEstimateDocumentPdfInner(estimate, { validThrough = null } = {}) {
  const url = estimateDocumentUrl(estimate.token, { validThrough });
  const browser = await launchBrowser();
  let page = null;
  try {
    page = await browser.newPage({ viewport: { width: 1120, height: 1440 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('.estimate-document-v1', { timeout: 10000 });
    await page.emulateMedia({ media: 'print', colorScheme: 'light' });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="font-size:8px; width:100%; text-align:center; color:#999;">Waves Pest Control &middot; Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
    return Buffer.from(pdf);
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

const safeFilename = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'waves';

// SendGrid attachment shape — same filename convention as the pdfkit
// attachment builder so the email channel is unchanged either way.
async function buildEstimateDocEmailAttachment(estimate, { validThrough = null } = {}) {
  const buffer = await renderEstimateDocumentPdf(estimate, { validThrough });
  const { normalizeProposal } = require('../estimate-proposal');
  const proposal = normalizeProposal(estimate);
  return {
    filename: `Waves-Proposal-${safeFilename(proposal.preparedFor || estimate.id)}.pdf`,
    content: buffer.toString('base64'),
    type: 'application/pdf',
    disposition: 'attachment',
  };
}

// Preferred attachment entry point for the send path: browser document when
// the gate is on, pdfkit otherwise or on ANY render failure. Throwing only
// when BOTH generators fail preserves the send path's "no proposal email
// without its PDF" contract.
async function buildEstimateProposalEmailAttachmentPreferred(estimate, { validThrough = null } = {}) {
  const featureGates = require('../../config/feature-gates');
  if (featureGates.isEnabled('estimateDocPdf')) {
    try {
      return await buildEstimateDocEmailAttachment(estimate, { validThrough });
    } catch (e) {
      logger.warn(`[estimate-doc-pdf] browser attachment render failed for estimate ${estimate?.id}; falling back to pdfkit: ${e.message}`);
    }
  }
  const { buildEstimateProposalEmailAttachment } = require('./estimate-pdf');
  // The pdfkit builder reads expires_at off the row it's handed — thread the
  // same override the browser path advertises via the pin.
  return buildEstimateProposalEmailAttachment(validThrough ? { ...estimate, expires_at: validThrough } : estimate);
}

module.exports = {
  signEstimateDocPin,
  verifyEstimateDocPin,
  estimateDocumentUrl,
  renderEstimateDocumentPdf,
  buildEstimateDocEmailAttachment,
  buildEstimateProposalEmailAttachmentPreferred,
};
