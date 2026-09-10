const crypto = require('node:crypto');
const { PDFDocument, PDFArray, PDFDict, PDFName, PDFRef, PDFStream, PDFRawStream, StandardFonts, rgb } = require('pdf-lib');
const { normalizeProposal, computeProposalTotals } = require('../estimate-proposal');
const { assertBidSendDate } = require('../proposal-bid');
const { validDateOnly } = require('../../utils/date-only');
const { BID_FORM_PROFILES, roundCents, roundDecimal, proposalLineAmount, formatQuantity, formatUnitPrice } = require('../../../shared/proposal-bid.cjs');

// Fingerprints of the blank form page, not of customer documents: the
// content streams (drawing commands) AND the page's resource dependencies —
// fonts, images/XObjects, graphics states, colour spaces — hashed by their
// object content, so a page that keeps the approved commands but swaps a
// referenced image, font or graphics state is refused too (GH codex P2 r2 on
// #4270). Requiring the reviewed page prevents prices being overlaid on a
// different revision/layout. Originals are supplied per download and never
// stored. The `packet` value covers every OTHER page of the reviewed
// original (content, resources and annotation count), so a packet whose
// bidder or attestation pages were filled and flattened — no AcroForm value
// left to inspect, the entries baked into those pages' content streams — is
// refused instead of exported with stale data (GH codex P2 r3 on #4270).
// A revised original needs a reviewed profile update: run
// `node server/scripts/bid-form-fingerprint.js <pdf> <page>` on the original
// and record all three values here.
const FORM_PAGE_FINGERPRINTS = {
  north_port_pr27_02: { contents: '728fcdbde060cbbd0406774aaab47bbff7e0a47bd34eca8ece46d30fb5d4ea45', resources: 'f56ba209011ca8db6793e1f5f75b2099106881c1905979655f2714700f2352e3', packet: 'aa885d3f6874cbb05f3e63b20726e3c398e39ff2077b20c3e9082527ad886d8a' },
  cove_termite: { contents: '04aa8cb7b95eacb57c550a743796078bd113aa8a3a129ca7928241b225ca84f4', resources: 'eba4dad62d71a3a86f5b1148d7653f8ad4980710562a95090b58b60f6c7f27d7', packet: '215dee4565fe48425e07df4d6c9bdb3b2e2db3bf13f7c96e28ad850b0ef92afa' },
};
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
// Hash every object the page's /Resources reaches (dictionaries by sorted
// key, streams by dictionary + raw bytes), following references once.
// Standard fonts a previous pdf-lib export added (`/Helvetica-<n>`) and the
// empty resource categories it creates (an `/XObject` dictionary with no
// entries) are skipped so a fingerprint recorded from a reviewed export of
// the original equals the original's; the approved content stream never
// references them.
const sortedEntries = (dict) => [...dict.entries()].sort((a, b) => (a[0].toString() < b[0].toString() ? -1 : 1));
// Feeds a PDF object graph into `hash`: dictionaries by sorted key, streams
// by dictionary + raw bytes, references followed once. `/Parent` and `/P`
// back-links are skipped so a widget hashes without its field's `/V` (checked
// separately), and a reference to a page object hashes as the reference
// alone — pages are fingerprinted on their own, and an outline, destination
// or structure element pointing at the drawn page must not change with it.
function objectHasher(document, hash) {
  const seen = new Set();
  const visitDict = (dict) => {
    hash.update('<<');
    for (const [key, value] of sortedEntries(dict)) {
      const name = key.toString();
      if (name === '/Parent' || name === '/P') continue;
      hash.update(name);
      visit(value);
    }
    hash.update('>>');
  };
  const visit = (value) => {
    if (value instanceof PDFRef) {
      const key = value.toString();
      if (seen.has(key)) { hash.update('ref-seen'); return; }
      seen.add(key);
      value = document.context.lookup(value);
      if (value instanceof PDFDict && value.get(PDFName.of('Type')) === PDFName.of('Page')) { hash.update(`page-ref:${key}`); return; }
    }
    if (value instanceof PDFStream) {
      hash.update('stream');
      visitDict(value.dict);
      hash.update(value instanceof PDFRawStream ? Buffer.from(value.contents) : Buffer.from(value.getContents ? value.getContents() : []));
      return;
    }
    if (value instanceof PDFDict) { visitDict(value); return; }
    if (value instanceof PDFArray) { hash.update('['); value.asArray().forEach(visit); hash.update(']'); return; }
    hash.update(String(value));
  };
  return visit;
}
function pageResourceHash(document, page) {
  const hash = crypto.createHash('sha256');
  const visit = objectHasher(document, hash);
  const resources = page.node.Resources();
  if (!resources) return hash.update('none').digest('hex');
  for (const [key, value] of sortedEntries(resources)) {
    const dict = document.context.lookup(value);
    if (dict instanceof PDFDict && dict.keys().length === 0) continue;
    hash.update(key.toString());
    if (key.toString() === '/Font' && dict instanceof PDFDict) {
      hash.update('<<');
      for (const [fontKey, fontValue] of sortedEntries(dict)) {
        if (/^\/Helvetica-\d+$/.test(fontKey.toString())) continue;
        hash.update(fontKey.toString());
        visit(fontValue);
      }
      hash.update('>>');
    } else visit(value);
  }
  return hash.digest('hex');
}
function pageFingerprint(document, page) {
  return { contents: pageContentHash(document, page), resources: pageResourceHash(document, page) };
}
// Every page except the selected form page, in order: the page count, each
// page's visible geometry (media/crop box, rotation), drawing commands,
// resources and its annotation objects — the original's own blank widgets
// with their appearance streams, hashed as objects rather than counted, so a
// cropped or rotated attestation page or a widget whose appearance was
// altered without setting `/V` is refused too (GH codex P2 r4 on #4270).
// Flattening a filled field rewrites the content stream and drops the
// widget; a stamp or an added or removed page changes the sequence. The
// selected page is excluded because it is fingerprinted on its own, which
// also lets the value be recorded from a reviewed export whose only change
// is that page.
function packetFingerprint(document, selectedIndex) {
  const hash = crypto.createHash('sha256');
  const visit = objectHasher(document, hash);
  const pages = document.getPages();
  hash.update(`pages:${pages.length};selected:${selectedIndex};`);
  pages.forEach((page, index) => {
    if (index === selectedIndex) return;
    const box = (b) => [b.x, b.y, b.width, b.height].join(',');
    hash.update(`${index}:media=${box(page.getMediaBox())};crop=${box(page.getCropBox())};rotate=${page.getRotation().angle};`);
    hash.update(`${pageContentHash(document, page)}:${pageResourceHash(document, page)};annots:`);
    const annots = page.node.Annots();
    if (annots) visit(annots); else hash.update('none');
    hash.update(';');
  });
  // Catalog state other than the page tree: the name trees (destinations
  // and the original's JavaScript), viewer preferences, structure, metadata,
  // and the AcroForm's own settings.
  hash.update('catalog:');
  for (const [key, value] of sortedEntries(document.catalog)) {
    const name = key.toString();
    if (name === '/Pages') continue;
    hash.update(name);
    if (name === '/AcroForm') visitAcroFormSettings(document, value, hash, visit); else visit(value);
  }
  return hash.digest('hex');
}
// Fields are covered by their widgets and the value check; `/DR` holds only
// the fonts an export may add. Everything else (DA, SigFlags, XFA, CO,
// NeedAppearances) is pinned.
function visitAcroFormSettings(document, value, hash, visit) {
  const acroForm = document.context.lookup(value);
  hash.update('<<');
  if (acroForm instanceof PDFDict) {
    for (const [key, entry] of sortedEntries(acroForm)) {
      if (key.toString() === '/Fields' || key.toString() === '/DR') continue;
      hash.update(key.toString()); visit(entry);
    }
  }
  hash.update('>>');
}
function pageContentHash(document, page) {
  const contents = page.node.Contents();
  // A page with no content stream (an inserted blank sheet) hashes as empty.
  const streams = contents == null ? [] : contents instanceof PDFArray ? contents.asArray() : [contents];
  return crypto.createHash('sha256').update(Buffer.concat(streams.map((ref) => {
    const stream = document.context.lookup(ref);
    if (typeof stream?.getContents !== 'function') throw invalid('The uploaded PDF has an unsupported page format.');
    return Buffer.from(stream.getContents());
  }))).digest('hex');
}

// The content-stream hash proves the printed layout; the rest of the page and
// form state must be blank too (GH codex P2 on #4270). The reviewed originals
// carry no annotations on the exported page, and their fields (North Port's
// AcroForm on other pages) are empty, so a filled-in or annotated copy, a
// signed packet, or a page whose visible box was cropped or shifted is refused
// rather than preserved into the export.
function assertBlankFormState(document, page) {
  const boxes = [page.getMediaBox(), page.getCropBox()].every((box) => Math.abs(box.x) <= 0.1 && Math.abs(box.y) <= 0.1
    && Math.abs(box.width - 612) <= 0.1 && Math.abs(box.height - 792) <= 0.1);
  if (!boxes || page.getRotation().angle !== 0) throw invalid('This page does not match the supported blank bid form. Select the original form page; revised layouts need a reviewed template.');
  if ((page.node.Annots()?.size() || 0) > 0) throw invalid('The selected page carries annotations or form fields. Upload the untouched original form.');
  assertInertDocument(document);
  const acroForm = document.catalog.lookup(PDFName.of('AcroForm'));
  if (!acroForm) return;
  // The reviewed North Port original ships unsigned signature fields with
  // SigFlags 1 (SignaturesExist); a signature is a `/Sig` field carrying a
  // value, and AppendOnly (bit 2) marks a document locked by one.
  const fields = document.getForm().getFields();
  const signed = (Number(acroForm.lookup(PDFName.of('SigFlags'))?.asNumber?.() || 0) & 2) !== 0
    || fields.some((field) => field.acroField.dict.get(PDFName.of('FT')) === PDFName.of('Sig') && field.acroField.dict.get(PDFName.of('V')) != null);
  if (signed) throw invalid('This PDF has been signed or prepared for signature. Upload the untouched original form.');
  const filled = fields.some((field) => field.acroField.dict.get(PDFName.of('V')) != null);
  if (filled) throw invalid('This PDF has form fields already filled in. Upload the untouched original form.');
}

// Document-level state survives `PDFDocument.save()` untouched, so the
// catalog may only hold inert, reviewed entries (GH codex P2 r5 on #4270):
// no open action, document or page actions, embedded files, permissions or
// collections. The name tree may carry destinations and the original's own
// JavaScript, which the packet fingerprint pins to the reviewed original.
const INERT_CATALOG_KEYS = new Set(['/Type', '/Pages', '/AcroForm', '/Lang', '/MarkInfo', '/Metadata', '/Names', '/OutputIntents', '/StructTreeRoot', '/ViewerPreferences', '/PageMode', '/PageLayout', '/Outlines', '/PageLabels', '/Version', '/Extensions', '/Dests', '/OCProperties']);
const INERT_NAME_TREES = new Set(['/Dests', '/JavaScript']);
function assertInertDocument(document) {
  const refuse = () => { throw invalid('This PDF carries actions, scripts, attachments or restrictions the reviewed original does not. Upload the untouched original form.'); };
  if (document.catalog.keys().some((key) => !INERT_CATALOG_KEYS.has(key.toString()))) refuse();
  const names = document.catalog.lookup(PDFName.of('Names'));
  if (names instanceof PDFDict && names.keys().some((key) => !INERT_NAME_TREES.has(key.toString()))) refuse();
  if (document.getPages().some((page) => page.node.get(PDFName.of('AA')) != null)) refuse();
}

function mapFormPrices(proposal, template, mapping = {}) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw invalid('Choose a form row for every quoted line.');
  const profile = Object.hasOwn(BID_FORM_PROFILES, template) ? BID_FORM_PROFILES[template] : null;
  if (!profile) throw invalid('Choose a supported bid form.');
  if (proposal.enabled !== true || proposal.synthesized) throw invalid('Save an authored proposal before exporting a bid form.');
  if (!validDateOnly(proposal.validThrough)) throw invalid('Set an explicit Valid through date that meets the bid’s price-hold requirement before exporting.');
  // RFQ page 13: 90 days after bid due. Addendum No. 1 (September 8)
  // moves that due date to September 22, 2026; the end date is December 21.
  if (profile.minimumValidThrough && proposal.validThrough < profile.minimumValidThrough) throw invalid('North Port requires a 90-day price hold after the amended bid due date. Set Valid through to December 21, 2026 or later.');
  if (proposal.programs?.length || proposal.correctiveWork?.length) throw invalid('These bid forms use one-time building line items. Move all quoted charges into that itemization before exporting.');
  const lines = proposal.buildings.flatMap((building) => building.lineItems);
  if (!lines.length || lines.some((line) => !line.id || line.frequency !== 'one_time')) throw invalid('Each bid-form line needs a saved identifier and One-time frequency. Save the building lines in the proposal builder first.');
  if (new Set(lines.map((line) => line.id)).size !== lines.length) throw invalid('Proposal line identifiers are duplicated. Save unique lines before exporting.');
  const ids = new Set(lines.map((line) => line.id));
  if (Object.keys(mapping).some((id) => !ids.has(id))) throw invalid('The form mapping contains a removed line. Review the current proposal lines.');
  const groups = Object.fromEntries(Object.keys(profile.rows).map((key) => [key, []]));
  for (const line of lines) {
    if (!Object.hasOwn(groups, mapping[line.id])) throw invalid(`Choose a form row for “${line.description}”. Every quoted line must be included once.`);
    groups[mapping[line.id]].push(line);
  }
  const totals = computeProposalTotals(proposal);
  const amounts = Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, roundCents(items.reduce((sum, line) => sum + line.amount, 0))]));
  if (template === 'north_port_pr27_02') {
    if (totals.totalTax !== 0) throw invalid('This quote form has no sales-tax field. Review the tax treatment before exporting.');
    if (totals.firstYearTotal > 34999.99) throw invalid('North Port PR27-02 limits the total quote to $34,999.99.');
    for (const [key, units] of [['product', ['lb', 'gal']], ['application', ['acre']]]) {
      const rows = groups[key];
      if (!rows.length || rows.some((row) => !units.includes(row.unit) || row.unit !== rows[0].unit || row.unitPrice !== rows[0].unitPrice)) throw invalid(`${profile.rows[key]} needs lines with one consistent unit and unit price (${units.join(' or ')}).`);
      // Combining multiple individually rounded charges must still reconcile
      // with the single unit price and combined quantity printed on this form.
      const quantity = roundDecimal(rows.reduce((sum, row) => sum + row.quantity, 0));
      if (proposalLineAmount({ quantity, unitPrice: rows[0].unitPrice }) !== amounts[key]) throw invalid(`The combined ${key} quantity and unit price differ from the saved line amounts by rounding. Consolidate those proposal lines before exporting.`);
    }
    if (groups.other.length > 1) throw invalid('The additional-item row supports one quoted line. Consolidate additional charges first.');
  } else {
    // Cove's form explicitly asks for SF. Other units can contribute dollars
    // to a row, but cannot be relabeled as area or counted as slab coverage.
    for (const [key, rows] of Object.entries(groups)) {
      if (!rows.some((row) => row.unit === 'sqft')) throw invalid(`${profile.rows[key]} needs its reviewed square-foot quantity on a proposal line. Include each treated area once.`);
    }
    // Base bid includes tax. Allocate the cent-rounded total across form rows.
    const taxShares = Object.keys(groups).map((key) => {
      const cents = groups[key].filter((row) => row.taxable).reduce((sum, row) => sum + row.amount, 0) * proposal.taxRate * 100;
      const whole = Math.floor(cents + 1e-6);
      return { key, whole, remainder: cents - whole };
    }).sort((a, b) => b.remainder - a.remainder);
    let remainder = Math.round(totals.totalTax * 100) - taxShares.reduce((sum, share) => sum + share.whole, 0);
    for (const share of taxShares) {
      const cents = share.whole + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      amounts[share.key] = roundCents(amounts[share.key] + cents / 100);
    }
  }
  return { groups, amounts, total: totals.firstYearTotal };
}

async function buildProposalBidForm({ estimate, sourcePdf, template, pageNumber, mapping, details = {} }) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) throw invalid('Form details must be an object.');
  if (!Buffer.isBuffer(sourcePdf) || sourcePdf.length > 12 * 1024 * 1024 || sourcePdf.subarray(0, 5).toString() !== '%PDF-') throw invalid('Upload the original PDF (up to 12 MB).');
  const proposal = normalizeProposal(estimate);
  // A lapsed fixed hold must never produce a submission-ready form with
  // expired prices (pre-push codex P1 on #4270); same 409 as sending.
  assertBidSendDate(estimate);
  const prices = mapFormPrices(proposal, template, mapping);
  let document;
  try { document = await PDFDocument.load(sourcePdf); } catch { throw invalid('The PDF could not be read. Upload the original, unencrypted form.'); }
  if (document.getPageCount() > 100) throw invalid('Upload the bid-form PDF with no more than 100 pages.');
  if (!Number.isInteger(Number(pageNumber)) || pageNumber < 1 || pageNumber > document.getPageCount()) throw invalid('The selected form page is outside this PDF.');
  const page = document.getPage(Number(pageNumber) - 1);
  assertBlankFormState(document, page);
  const expected = module.exports.FORM_PAGE_FINGERPRINTS[template];
  const actual = pageFingerprint(document, page);
  if (actual.contents !== expected.contents || actual.resources !== expected.resources) throw invalid('This page does not match the supported blank bid form. Select the original form page; revised layouts need a reviewed template.');
  if (packetFingerprint(document, Number(pageNumber) - 1) !== expected.packet) throw invalid('The other pages of this PDF differ from the reviewed original packet. Upload the untouched original form.');
  const font = await document.embedFont(StandardFonts.Helvetica);
  // Coordinates are points measured from the top of each reviewed original.
  const write = (text, x, top, width, size = 9) => {
    const content = String(text ?? '').trim();
    if (!content) return;
    if (content.length > 500 || /[\r\n]/.test(content)) throw invalid('Keep each form field to one line.');
    try {
      while (size > 7 && font.widthOfTextAtSize(content, size) > width) size -= 0.25;
      if (font.widthOfTextAtSize(content, size) > width) throw invalid('A form field is too long to fit. Shorten the entry and try again.');
      page.drawText(content, { x, y: page.getHeight() - top - size, size, font, color: rgb(0, 0, 0) });
    } catch (err) {
      if (err.statusCode) throw err;
      throw invalid('A form field contains characters this PDF font cannot print. Use plain text.');
    }
  };
  const number = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (template === 'north_port_pr27_02') {
    const { groups, amounts, total } = prices;
    for (const [key, top] of [['product', 144], ['application', 180], ['other', 197]]) {
      if (!groups[key].length) continue;
      write(formatUnitPrice(groups[key][0].unitPrice), 410, top, 63);
      write(number(amounts[key]), 480, top, 92);
    }
    if (groups.other.length) {
      write(groups.other[0].description, 79, 197, 260, 8);
      write(formatQuantity(groups.other[0]), 348, 197, 54, 8);
    }
    write(number(roundCents(total - amounts.freight)), 514, 251, 59, 8);
    write(number(amounts.freight), 514, 270, 59, 8);
    write(number(total), 449, 314, 123, 10);
    write(details.shippingMethod, 132, 344, 438);
    write(details.leadTime, 325, 372, 245);
    const quantities = ['product', 'application'].map((key) => `${key === 'product' ? 'Product quantity' : 'Application area'}: ${formatQuantity({ ...groups[key][0], quantity: roundDecimal(groups[key].reduce((sum, row) => sum + row.quantity, 0)) })}`).join('; ');
    write(quantities, 38, 448, 530);
    write(details.comments, 38, 466, 530);
    write(details.companyName || 'Waves Pest Control, LLC', 150, 522, 420);
    write(details.authorizedName, 340, 552, 230);
    // Signature, date, discount and the packet's legal attestations remain blank.
  } else {
    const { groups, amounts, total } = prices;
    for (const [key, top] of [['apartments', 146], ['clubhouse', 157.3], ['garages', 168.5]]) {
      const quantity = roundDecimal(groups[key].filter((row) => row.unit === 'sqft').reduce((sum, row) => sum + row.quantity, 0));
      write(quantity.toLocaleString('en-US', { maximumFractionDigits: 4 }), 400, top, 47, 8);
      write(number(amounts[key]), 509, top, 63, 8);
    }
    write(number(total), 499, 185, 74, 8);
    if (details.ocipDeduct == null || String(details.ocipDeduct).trim() === '') throw invalid('Enter the Cove OCIP deduct alternate, including zero if there is no deduct.');
    {
      const deduct = Number(details.ocipDeduct);
      if (!Number.isFinite(deduct) || deduct < 0 || deduct > total || roundCents(deduct) !== deduct) throw invalid('The OCIP deduct alternate must be a whole-cent amount between zero and the base bid total.');
      write(number(deduct), 509, 227.5, 63, 8);
    }
  }
  return Buffer.from(await document.save());
}
module.exports = { buildProposalBidForm, mapFormPrices, pageContentHash, pageResourceHash, pageFingerprint, packetFingerprint, FORM_PAGE_FINGERPRINTS };
