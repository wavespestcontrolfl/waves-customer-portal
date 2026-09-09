const crypto = require('node:crypto');
const { PDFDocument, PDFArray, StandardFonts, rgb } = require('pdf-lib');
const { normalizeProposal, computeProposalTotals } = require('../estimate-proposal');
const { validDateOnly } = require('../../utils/date-only');
const { BID_FORM_PROFILES, roundCents, roundDecimal, proposalLineAmount, formatQuantity, formatUnitPrice } = require('../../../shared/proposal-bid.cjs');

// Hashes of the blank form page's content streams, not of customer documents.
// Requiring the reviewed page prevents prices being overlaid on a different
// revision/layout. Originals are supplied per download and are never stored.
const FORM_PAGE_HASHES = {
  north_port_pr27_02: '728fcdbde060cbbd0406774aaab47bbff7e0a47bd34eca8ece46d30fb5d4ea45',
  cove_termite: '04aa8cb7b95eacb57c550a743796078bd113aa8a3a129ca7928241b225ca84f4',
};
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
function pageContentHash(document, page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return crypto.createHash('sha256').update(Buffer.concat(streams.map((ref) => {
    const stream = document.context.lookup(ref);
    if (typeof stream?.getContents !== 'function') throw invalid('The uploaded PDF has an unsupported page format.');
    return Buffer.from(stream.getContents());
  }))).digest('hex');
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
  const prices = mapFormPrices(proposal, template, mapping);
  let document;
  try { document = await PDFDocument.load(sourcePdf); } catch { throw invalid('The PDF could not be read. Upload the original, unencrypted form.'); }
  if (document.getPageCount() > 100) throw invalid('Upload the bid-form PDF with no more than 100 pages.');
  if (!Number.isInteger(Number(pageNumber)) || pageNumber < 1 || pageNumber > document.getPageCount()) throw invalid('The selected form page is outside this PDF.');
  const page = document.getPage(Number(pageNumber) - 1);
  if (Math.abs(page.getWidth() - 612) > 0.1 || Math.abs(page.getHeight() - 792) > 0.1 || page.getRotation().angle !== 0
    || pageContentHash(document, page) !== FORM_PAGE_HASHES[template]) throw invalid('This page does not match the supported blank bid form. Select the original form page; revised layouts need a reviewed template.');
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
module.exports = { buildProposalBidForm, mapFormPrices, pageContentHash };
