// Exact-registration PPLS lookup. Only EPA's fixed JSON/PDF origins are fetched;
// neither user input nor an upstream response can supply an arbitrary URL.
const { createHash } = require('crypto');
const { PDFDocument } = require('pdf-lib');

const REGISTRATION_RE = /^[1-9]\d{0,5}-[1-9]\d{0,5}$/;
const PDF_RE = /^(\d{6})-(\d{5})-(\d{8})\.pdf$/;
const PDF_BASE = 'https://www3.epa.gov/pesticides/chem_search/ppls/';
const MAX_PDF_BYTES = 8 * 1024 * 1024;

function labelError(message, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode });
}

async function readBounded(url, maxBytes) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.body) throw labelError('EPA source is unavailable. Try again later.', 502);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();
    throw labelError('EPA document exceeds the supported size. Review the source manually.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw labelError('EPA document exceeds the supported size. Review the source manually.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function selectEpaSource(payload, registration) {
  const matches = (payload?.items || []).filter((item) => item.eparegno === registration);
  if (matches.length !== 1 || matches[0].product_status !== 'Active' || matches[0].cancel_flag !== 'No') {
    throw labelError('No single active EPA registration matched. Check the catalog registration.');
  }
  const item = matches[0];
  const documents = (item.pdffiles || []).filter((doc) => {
    const match = PDF_RE.exec(doc.pdffile || '');
    return match && `${Number(match[1])}-${Number(match[2])}` === registration && doc.epa_reg_num === registration;
  }).sort((a, b) => b.pdffile.localeCompare(a.pdffile));
  if (!documents.length) throw labelError('No supported label PDF matches this registration.');
  return {
    registration, productName: String(item.productname || '').slice(0, 300),
    filename: documents[0].pdffile, acceptedDate: documents[0].pdffile_accepted_date || null,
    url: PDF_BASE + documents[0].pdffile,
  };
}

async function downloadEpaLabel(source) {
  if (!PDF_RE.test(source.filename || '') || source.url !== PDF_BASE + source.filename) {
    throw labelError('Invalid EPA document reference.');
  }
  const bytes = await readBounded(source.url, MAX_PDF_BYTES);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw labelError('The EPA source did not return a PDF.');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageCount = pdf.getPageCount();
  if (!pageCount || pageCount > 100) throw labelError('This document needs manual review; the supported limit is 100 pages.');
  return { bytes, pageCount, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function findEpaLabel(registration) {
  if (!REGISTRATION_RE.test(registration || '')) {
    throw labelError('An exact two-part EPA registration is required. Transferred, distributor, and exempt products need manual source review.');
  }
  const bytes = await readBounded(`https://ordspub.epa.gov/ords/pesticides/cswu/ppls/${registration}`, 1024 * 1024);
  const source = selectEpaSource(JSON.parse(bytes.toString('utf8')), registration);
  return { source, ...await downloadEpaLabel(source) };
}

module.exports = { findEpaLabel, downloadEpaLabel, selectEpaSource, labelError };
