// Exact-registration PPLS lookup. Only EPA's fixed JSON/PDF origins are fetched;
// neither user input nor an upstream response can supply an arbitrary URL.
const { createHash } = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { normalizeForMatch } = require('./purchase-receipts/product-matcher');

const REGISTRATION_RE = /^[1-9]\d{0,5}-[1-9]\d{0,5}$/;
const DISTRIBUTOR_RE = /^[1-9]\d{0,5}-[1-9]\d{0,5}-[1-9]\d{0,5}$/;
const PDF_RE = /^(\d{6})-(\d{5})-(\d{8})\.pdf$/;
const PDF_BASE = 'https://www3.epa.gov/pesticides/chem_search/ppls/';
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const NAME_SEARCH_URL = 'https://ordspub.epa.gov/ords/pesticides/cswu/ProductSearch/partialprodsearch/v2/riname/';
const MAX_SEARCH_BYTES = 4 * 1024 * 1024; // a common word returns ~2,700 items
const MAX_ACTIVE_INGREDIENTS = 20;
const MAX_BRAND_NAMES = 20;
const MAX_BRAND_NAME_CHARS = 200;
// Cache status promises only, never PDF bytes; recheck within 60 seconds.
const sourceChecks = new Map();

function labelError(message, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

async function readBounded(url, maxBytes) {
  try {
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
  } catch (err) {
    if (err.isOperational) throw err;
    throw labelError('EPA source is unavailable. Try again later.', 502);
  }
}

// Every name the EPA record carries for the product: its product name plus each alternate brand name, trimmed, deduped, bounded.
function brandNamesOf(item) {
  const names = [item.productname, ...(Array.isArray(item.altbrandnames) ? item.altbrandnames.map((alt) => alt?.altbrandname) : [])];
  const seen = new Set();
  for (const name of names) {
    const text = typeof name === 'string' ? name.trim().slice(0, MAX_BRAND_NAME_CHARS) : '';
    if (text && seen.size < MAX_BRAND_NAMES) seen.add(text);
  }
  return [...seen];
}

// The record's active ingredient names (bounded); used only to tell a brand name from a name built from the chemical.
function activeIngredientNamesOf(item) {
  const names = (Array.isArray(item.active_ingredients) ? item.active_ingredients : [])
    .map((ingredient) => (typeof ingredient?.active_ing === 'string' ? ingredient.active_ing.trim().slice(0, MAX_BRAND_NAME_CHARS) : ''))
    .filter(Boolean);
  return [...new Set(names)].slice(0, MAX_ACTIVE_INGREDIENTS);
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
    registration, productName: String(item.productname || '').slice(0, 300), brandNames: brandNamesOf(item),
    activeIngredientNames: activeIngredientNamesOf(item),
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
  let pageCount;
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    pageCount = pdf.getPageCount();
  }
  catch { throw labelError('The EPA PDF could not be read. Review the source manually.'); }
  if (!pageCount || pageCount > 100) throw labelError('This document needs manual review; the supported limit is 100 pages.');
  return { bytes, pageCount, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function findEpaSource(registration) {
  if (!REGISTRATION_RE.test(registration || '')) {
    throw labelError('An exact two-part EPA registration is required. Transferred, distributor, and exempt products need manual source review.');
  }
  const bytes = await readBounded(`https://ordspub.epa.gov/ords/pesticides/cswu/ppls/${registration}`, 1024 * 1024);
  try { return selectEpaSource(JSON.parse(bytes.toString('utf8')), registration); }
  catch (err) {
    if (err.isOperational) throw err;
    throw labelError('EPA source is unavailable. Try again later.', 502);
  }
}

// ---- registration by brand name (new products the inventory agent creates) ----
// A name is the same product only when its CORE is equal: the normalized words minus the category nouns EPA appends
// ("TAURUS SC TERMITICIDE/INSECTICIDE" is "taurus sc"). Equality, never containment: "Gentrol" is not "GENTROL COMPLETE EC3".
const CATEGORY_NOUNS = new Set([
  'insecticide', 'insecticides', 'termiticide', 'termiticides', 'herbicide', 'herbicides', 'fungicide', 'fungicides',
  'miticide', 'miticides', 'nematicide', 'nematicides', 'rodenticide', 'rodenticides', 'larvicide', 'larvicides',
  'acaricide', 'acaricides',
]);

function coreOf(text) {
  return normalizeForMatch(text).split(' ').filter((word) => word && !CATEGORY_NOUNS.has(word)).join(' ');
}

// `altrntbrndnames` is one string of double-quoted names ("A", "B"), or null: every quoted segment is one name.
function altNamesOf(value) {
  const text = typeof value === 'string' ? value.replace(/\\/g, '') : '';
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function matchingBrandName(brandNames, target) {
  return (brandNames || []).find((name) => coreOf(name) === target) || null;
}

function foundFrom(source, matchedName, via, listingMismatch) {
  return {
    status: 'found', registration: source.registration, labelUrl: source.url, matchedName: String(matchedName).slice(0, MAX_BRAND_NAME_CHARS),
    acceptedDate: source.acceptedDate, via, ...(listingMismatch ? { listingMismatch: true } : {}),
  };
}

// The first core word with a letter and 3+ characters ("M-Pede" searches PEDE); failing that, the first with a letter.
function searchWordOf(coreWords) {
  return coreWords.find((word) => /[a-z]/.test(word) && word.length >= 3) || coreWords.find((word) => /[a-z]/.test(word));
}

// The listing's own number, checked against EPA's exact record: { found } when a record brand name equals the product name,
// { mismatch } when EPA answered and it does not (or is no active registration with a label), { unavailable } otherwise.
async function checkListingRegistration(listingRegistration, target) {
  try {
    const source = await findEpaSource(listingRegistration);
    const matchedName = matchingBrandName(source.brandNames, target);
    return matchedName ? { found: foundFrom(source, matchedName, 'listing') } : { mismatch: true };
  } catch (err) {
    return err?.isOperational && err.statusCode === 422 ? { mismatch: true } : { unavailable: true };
  }
}

// Every ACTIVE registration whose product name or alternate name has the product's core: { registrations } (two-part) and
// { distributors } (three-part, the number a distributor's bottle wears).
async function searchActiveRegistrations(searchWord, target) {
  const body = await readBounded(`${NAME_SEARCH_URL}${encodeURIComponent(searchWord.toUpperCase())}`, MAX_SEARCH_BYTES);
  const payload = JSON.parse(body.toString('utf8'));
  if (!Array.isArray(payload?.items)) throw labelError('EPA source is unavailable. Try again later.', 502);
  const registrations = new Set();
  const distributors = new Set();
  for (const item of payload.items) {
    if (item?.product_status !== 'Active') continue;
    if (item.product_name_status != null && item.product_name_status !== 'Active') continue;
    const twoPart = REGISTRATION_RE.test(item.eparegno || '');
    if (!twoPart && !DISTRIBUTOR_RE.test(item.eparegno || '')) continue;
    if ([item.productname, ...altNamesOf(item.altrntbrndnames)].some((candidate) => coreOf(candidate) === target)) {
      (twoPart ? registrations : distributors).add(item.eparegno);
    }
  }
  return { registrations, distributors };
}

// The one name-search hit, proven against its own exact record (the record is the authority). A result, or { unavailable }.
async function verifyNameSearchHit(registration, target, coreWords) {
  let source;
  try { source = await findEpaSource(registration); }
  catch (err) {
    return err?.isOperational && err.statusCode === 422 ? { status: 'not_found', reason: 'record_unusable' } : { status: 'unavailable' };
  }
  const matchedName = matchingBrandName(source.brandNames, target);
  if (!matchedName) return { status: 'not_found', reason: 'record_name_differs' };
  // A name built from the active ingredient ("Prodiamine 65 WDG") is sold by several registrants under near-identical names,
  // so one name match does not prove whose bottle this is. (Name search only: a listing number is the listing's own claim.)
  const ingredientWords = new Set((source.activeIngredientNames || []).flatMap((ingredient) => normalizeForMatch(ingredient).split(' ')));
  if (coreWords.some((word) => word.length >= 4 && ingredientWords.has(word))) return { status: 'not_found', reason: 'generic_name' };
  return foundFrom(source, matchedName, 'name_search');
}

// The registration and EPA label link for a product NAME, from EPA's own label system, when exactly one exact brand-name match
// proves it. Never throws. found | not_found | ambiguous | unavailable. Only fixed EPA origins are fetched; the one variable in
// a URL is a word of the product's core, which holds only a-z and 0-9.
async function findEpaRegistrationByName(name, { listingRegistration } = {}) {
  try {
    const target = coreOf(name);
    const coreWords = target.split(' ');
    const searchWord = searchWordOf(coreWords);
    if (!searchWord) return { status: 'not_found', reason: 'generic_name' };

    let listingMismatch = false;
    if (REGISTRATION_RE.test(listingRegistration || '')) {
      const listing = await checkListingRegistration(listingRegistration, target);
      if (listing.found) return listing.found;
      if (listing.unavailable) return { status: 'unavailable' };
      listingMismatch = true;
    }
    const withMismatch = (result) => (listingMismatch && result.status !== 'unavailable' ? { ...result, listingMismatch: true } : result);

    const { registrations, distributors } = await searchActiveRegistrations(searchWord, target);
    // A distributor registration (8033-106-1001) carries the same name on the bottle: the base number is not proof of which
    // number this product wears, so nothing is filled.
    if (distributors.size) return withMismatch({ status: 'ambiguous', reason: 'distributor_product', registrations: [...registrations, ...distributors].sort() });
    if (registrations.size === 0) return withMismatch({ status: 'not_found', reason: 'no_exact_name' });
    if (registrations.size > 1) return withMismatch({ status: 'ambiguous', registrations: [...registrations].sort() });
    return withMismatch(await verifyNameSearchHit([...registrations][0], target, coreWords));
  } catch {
    return { status: 'unavailable' };
  }
}

async function findEpaLabel(registration) {
  const source = await findEpaSource(registration);
  return { source, ...await downloadEpaLabel(source) };
}

async function currentEpaSourceStatus(source, { refresh = false } = {}) {
  const key = `${source?.registration}:${source?.filename}:${source?.sha256}`;
  const cached = sourceChecks.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    try {
      const latest = await findEpaSource(source?.registration);
      if (latest.filename !== source.filename) return 'superseded';
      const document = await downloadEpaLabel(latest);
      return document.sha256 === source.sha256 ? 'current' : 'superseded';
    } catch { return 'unavailable'; }
  })();
  sourceChecks.set(key, { promise, expiresAt: Date.now() + 60000 });
  if (sourceChecks.size > 128) sourceChecks.delete(sourceChecks.keys().next().value);
  return promise;
}

module.exports = { findEpaRegistrationByName, findEpaLabel, downloadEpaLabel, selectEpaSource, currentEpaSourceStatus, labelError };
