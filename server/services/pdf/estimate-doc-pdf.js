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

// Shared estimate/staff capacity — every render launches a Chromium process,
// and the public /:token/pdf route is reachable by any token holder. The
// per-IP route limiter can be bypassed by distributed callers, so this
// in-process semaphore is the real backstop: past the cap, renders throw
// `estimate_doc_render_busy`; estimate callers use their pdfkit fallback and
// staff callers return a retryable 503 instead of stacking browsers.
// Parsed as a finite positive integer — a nonnumeric/Infinity value would
// make the >= cap check never fire and silently disarm the memory-safety
// backstop (codex #3281 r2). Bad values fall back to the default.
const MAX_CONCURRENT_DOC_RENDERS = (() => {
  const parsed = Number.parseInt(String(process.env.ESTIMATE_DOC_PDF_MAX_CONCURRENT || ''), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
})();
let activeDocRenders = 0;

// Keep both renderers inside the existing capacity budget, including browser
// cleanup on success or failure. Estimate callers retain their pdfkit fallback.
async function withDocumentPdfCapacity(render) {
  if (activeDocRenders >= MAX_CONCURRENT_DOC_RENDERS) {
    const busy = new Error('Document PDF exports are busy. Try again shortly.');
    busy.code = 'estimate_doc_render_busy';
    busy.status = 503;
    throw busy;
  }
  activeDocRenders += 1;
  try {
    return await render();
  } finally {
    activeDocRenders -= 1;
  }
}

async function renderEstimateDocumentPdf(estimate, { validThrough = null } = {}) {
  if (!estimate?.token) throw new Error('estimate token required for document render');
  return withDocumentPdfCapacity(() => renderEstimateDocumentPdfInner(estimate, { validThrough }));
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

// Playwright navigation errors embed the full render URL, which carries the
// estimate BEARER token and the signed dpin — credentials that must never
// reach logs (AGENTS.md PII-in-logs rule; pre-push codex r5b). Every
// fallback log site (attachment builder + the public and admin download
// routes) passes its error through this before logging: query strings and
// /estimate/<token> path segments are redacted, plus any long hex run as a
// backstop for tokens quoted outside a URL. Bounded so a giant browser
// stack can't flood a log line.
function sanitizeRenderError(err) {
  return String(err?.message || err || '')
    .replace(/\?[^\s"')]*/g, '?[redacted-query]')
    .replace(/\/estimate\/[A-Za-z0-9_-]+/g, '/estimate/[redacted-token]')
    .replace(/[a-f0-9]{24,}/gi, '[redacted-hex]')
    .slice(0, 300);
}

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

// ── Estimate PDF on the customer email (owner ask 2026-10-19) ──────────────
// "Attach a pdf version of the estimates to all outgoing emails for customers
// who can't open the estimate", and no glass look. So this is the browser
// work-order document ONLY: there is no pdfkit fallback (that is the
// commercial "Proposal" look), and a failure returns null — the email then
// goes out as it always did, without the PDF or the note about it.
// The one line under the button when the PDF rides along. It is a template
// variable (`estimate_pdf_note`) so a send with no PDF drops the block and
// stays byte-identical to today.
const ESTIMATE_EMAIL_PDF_NOTES = Object.freeze({
  delivery: "Can't open the link? A PDF copy of this estimate is attached. To go ahead, reply to this email or call (941) 297-5749 and we'll set your first visit.",
  followUp: "Your estimate is attached as a PDF if the link won't open. Reply or call (941) 297-5749 to get started.",
});
const EMAIL_PDF_BUSY_ATTEMPTS = 3;
const EMAIL_PDF_BUSY_DELAY_MS = 8000;

function estimateEmailPdfEnabled() {
  const featureGates = require('../../config/feature-gates');
  return featureGates.isEnabled('estimateEmailPdf') && featureGates.isEnabled('estimateDocPdf');
}

// No customer name in the file name: the number the estimate page prints
// (estimate_slug), else a short id.
function estimateEmailPdfFilename(estimate) {
  const slug = String(estimate?.estimate_slug || estimate?.slug || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const fallback = String(estimate?.id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return `Waves-Estimate-${slug || fallback || 'copy'}.pdf`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits and retries while the render capacity is busy; any other failure throws.
async function renderWhileNotBusy(estimate, { validThrough, render, sleep, attempts, delayMs }) {
  const doRender = render || renderEstimateDocumentPdf;
  const wait = sleep || defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await doRender(estimate, { validThrough });
    } catch (e) {
      if (e?.code !== 'estimate_doc_render_busy' || attempt >= attempts) throw e;
      await wait(delayMs);
    }
  }
}

// A customer-emailed PDF is a disclosure to the customer exactly like the
// /:token/pdf download. The headless pass renders with a signed pin, which
// skips the served-disclosure write inside composeEstimateDataPayload, so the
// evidence must be durable BEFORE the render (the /pdf route's pre-render step,
// ensureRateReviewTermsEvidenceBeforeRender): an acceptance that follows the
// emailed document then still freezes the rate-review line the customer
// received. Returns the row to render and whether the line is withheld because
// its evidence is unproven. Never throws; fail closed (withhold).
async function rateReviewEvidenceForEmail(estimate) {
  try {
    const billingMod = require('../estimate-proposal-billing');
    const billing = await billingMod.resolveProposalBillingContext(estimate);
    return await billingMod.ensureRateReviewTermsEvidenceBeforeRender(estimate, { billing });
  } catch (e) {
    logger.warn(`[estimate-doc-pdf] rate review evidence check failed for estimate ${estimate?.id}: ${sanitizeRenderError(e)}`);
    return { estimate, withholdRateReviewTerms: true };
  }
}

// Returns a SendGrid attachment, or null. Never throws. When the rate-review
// evidence cannot be proven durable there is NO attachment: the browser
// renderer reads the row itself and cannot be told to withhold the line, and
// there is no pdfkit fallback for this copy, so the email goes out without it.
async function buildEstimateEmailPdfAttachment(estimate, { validThrough = null, render = null, sleep = null, attempts = EMAIL_PDF_BUSY_ATTEMPTS, delayMs = EMAIL_PDF_BUSY_DELAY_MS } = {}) {
  try {
    if (!estimateEmailPdfEnabled()) return null;
    const evidence = await rateReviewEvidenceForEmail(estimate);
    if (evidence.withholdRateReviewTerms) {
      logger.warn(`[estimate-doc-pdf] email PDF withheld for estimate ${estimate?.id}: rate review evidence unproven`);
      return null;
    }
    // The row the evidence step returns: a row that froze under it renders as it is now.
    const documentEstimate = evidence.estimate || estimate;
    const buffer = await renderWhileNotBusy(documentEstimate, { validThrough, render, sleep, attempts, delayMs });
    if (!buffer || !buffer.length) return null;
    return {
      filename: estimateEmailPdfFilename(documentEstimate),
      content: Buffer.from(buffer).toString('base64'),
      type: 'application/pdf',
      disposition: 'attachment',
    };
  } catch (e) {
    try {
      logger.warn(`[estimate-doc-pdf] email PDF skipped for estimate ${estimate?.id}: ${sanitizeRenderError(e)}`);
    } catch { /* logging must not turn a skipped PDF into a failed send */ }
    return null;
  }
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
      logger.warn(`[estimate-doc-pdf] browser attachment render failed for estimate ${estimate?.id}; falling back to pdfkit: ${sanitizeRenderError(e)}`);
    }
  }
  const { buildEstimateProposalEmailAttachment } = require('./estimate-pdf');
  // The pdfkit builder reads expires_at off the row it's handed — thread the
  // same override the browser path advertises via the pin.
  return buildEstimateProposalEmailAttachment(validThrough ? { ...estimate, expires_at: validThrough } : estimate);
}

module.exports = {
  withDocumentPdfCapacity,
  signEstimateDocPin,
  verifyEstimateDocPin,
  estimateDocumentUrl,
  renderEstimateDocumentPdf,
  buildEstimateDocEmailAttachment,
  buildEstimateProposalEmailAttachmentPreferred,
  buildEstimateEmailPdfAttachment,
  estimateEmailPdfEnabled,
  ESTIMATE_EMAIL_PDF_NOTES,
  estimateEmailPdfFilename,
  sanitizeRenderError,
};
