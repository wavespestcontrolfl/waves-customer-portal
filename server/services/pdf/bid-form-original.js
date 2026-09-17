const crypto = require('node:crypto');
const { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, PDFRawStream } = require('pdf-lib');

const FORM_PAGE_FINGERPRINTS = {
  north_port_pr27_02: { contents: '7605ce407e06a60e76aa10bf5909d73020dba95a01c3c88c35d8fd53bfa515a3', resources: '8f8dd15efaf336d0fed58631876ec381b2712cbb6d29b5f15841d413560043e9', packet: '65106f757cec51e1e1c70e0ed78f4c777a45b7a6c00d4752eb3f03319133c136' },
  cove_termite: { contents: 'c2510d9ae0616ba91975260f799851e17f874769f2b2061c0db076c840f1ffa0', resources: 'da975e4497103e7eaed5ccb3fe24e99aef2d49814551b7caf04bcbd1fd3abe74', packet: 'dc2076d8cc4e1e9a8cf6297c90dfe8e3f34d2de4f4233df3fbc3bc4bb0923b73' },
};
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
const sortedEntries = (dict) => [...dict.entries()].sort((a, b) => (a[0].toString() < b[0].toString() ? -1 : 1));
function objectHasher(document, hash) {
  const seen = new Set();
  const visitDict = (dict) => {
    hash.update('<<');
    for (const [key, value] of sortedEntries(dict)) {
      const name = key.toString();
      if (name === '/Parent' || name === '/P') continue;
      hash.update(`${name}=`);
      visit(value);
    }
    hash.update('>>');
  };
  const visit = (value) => {
    if (value instanceof PDFRef) {
      const key = value.toString();
      if (seen.has(key)) { hash.update(`ref-seen:${key};`); return; }
      seen.add(key);
      value = document.context.lookup(value);
      if (value instanceof PDFDict && value.get(PDFName.of('Type')) === PDFName.of('Page')) { hash.update(`page-ref:${key};`); return; }
    }
    if (value instanceof PDFStream) {
      const bytes = value instanceof PDFRawStream ? Buffer.from(value.contents) : Buffer.from(value.getContents ? value.getContents() : []);
      hash.update('stream');
      visitDict(value.dict);
      hash.update(`${bytes.length}:`);
      hash.update(bytes);
      hash.update(';');
      return;
    }
    if (value instanceof PDFDict) { visitDict(value); return; }
    if (value instanceof PDFArray) { hash.update('['); value.asArray().forEach((item) => { visit(item); hash.update(','); }); hash.update(']'); return; }
    const text = String(value);
    hash.update(`${value?.constructor?.name || typeof value}:${text.length}:${text};`);
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
const PAGE_KEYS_HASHED_SEPARATELY = new Set(['/Contents', '/Resources', '/Annots', '/Parent']);
function packetFingerprint(document, selectedIndex) {
  const hash = crypto.createHash('sha256');
  const visit = objectHasher(document, hash);
  const pages = document.getPages();
  hash.update(`pages:${pages.length};selected:${selectedIndex};`);
  pages.forEach((page, index) => {
    if (index !== selectedIndex) {
      const box = (b) => [b.x, b.y, b.width, b.height].join(',');
      hash.update(`${index}:media=${box(page.getMediaBox())};crop=${box(page.getCropBox())};rotate=${page.getRotation().angle};`);
      hash.update(`${pageContentHash(document, page)}:${pageResourceHash(document, page)};annots:`);
      const annots = page.node.Annots();
      if (annots) visit(annots); else hash.update('none');
    } else hash.update(`${index}:selected`);
    hash.update(';dict:<<');
    for (const [key, value] of sortedEntries(page.node)) {
      if (PAGE_KEYS_HASHED_SEPARATELY.has(key.toString())) continue;
      hash.update(`${key.toString()}=`); visit(value);
    }
    hash.update('>>;');
  });
  hash.update('catalog:');
  for (const [key, value] of sortedEntries(document.catalog)) {
    const name = key.toString();
    if (name === '/Pages') continue;
    hash.update(name);
    if (name === '/AcroForm') visitAcroFormSettings(document, value, hash, visit); else visit(value);
  }
  return hash.digest('hex');
}
function visitAcroFormSettings(document, value, hash, visit) {
  const acroForm = document.context.lookup(value);
  hash.update('<<');
  if (acroForm instanceof PDFDict) {
    for (const [key, entry] of sortedEntries(acroForm)) {
      if (key.toString() === '/DR') continue;
      hash.update(`${key.toString()}=`); visit(entry);
    }
  }
  hash.update('>>');
}
// Pin each stream's dictionary (Filter/DecodeParms) and framed bytes, not just
// concatenated bytes: changing decoding can change printed content.
function pageContentHash(document, page) {
  const contents = page.node.Contents();
  const streams = contents == null ? [] : contents instanceof PDFArray ? contents.asArray() : [contents];
  const hash = crypto.createHash('sha256');
  const visit = objectHasher(document, hash);
  hash.update(`streams:${streams.length};`);
  for (const ref of streams) {
    const stream = document.context.lookup(ref);
    if (!(stream instanceof PDFStream)) throw invalid('The uploaded PDF has an unsupported page format.');
    visit(stream);
  }
  return hash.digest('hex');
}

function assertBlankFormState(document, page) {
  const boxes = [page.getMediaBox(), page.getCropBox()].every((box) => Math.abs(box.x) <= 0.1 && Math.abs(box.y) <= 0.1
    && Math.abs(box.width - 612) <= 0.1 && Math.abs(box.height - 792) <= 0.1);
  const userUnit = page.node.lookup(PDFName.of('UserUnit'));
  const scaled = userUnit != null && Number(userUnit.asNumber?.() ?? NaN) !== 1;
  if (!boxes || page.getRotation().angle !== 0 || scaled) throw invalid('This page does not match the supported blank bid form. Select the original form page; revised layouts need a reviewed template.');
  if ((page.node.Annots()?.size() || 0) > 0) throw invalid('The selected page carries annotations or form fields. Upload the untouched original form.');
  assertInertDocument(document);
  const acroForm = document.catalog.lookup(PDFName.of('AcroForm'));
  if (!acroForm) return;
  const fields = document.getForm().getFields();
  const signed = (Number(acroForm.lookup(PDFName.of('SigFlags'))?.asNumber?.() || 0) & 2) !== 0
    || fields.some((field) => field.acroField.dict.get(PDFName.of('FT')) === PDFName.of('Sig') && field.acroField.dict.get(PDFName.of('V')) != null);
  if (signed) throw invalid('This PDF has been signed or prepared for signature. Upload the untouched original form.');
  const filled = fields.some((field) => field.acroField.dict.get(PDFName.of('V')) != null);
  if (filled) throw invalid('This PDF has form fields already filled in. Upload the untouched original form.');
}

const INERT_CATALOG_KEYS = new Set(['/Type', '/Pages', '/AcroForm', '/Lang', '/MarkInfo', '/Metadata', '/Names', '/OutputIntents', '/StructTreeRoot', '/ViewerPreferences', '/PageMode', '/PageLayout', '/Outlines', '/PageLabels', '/Version', '/Extensions', '/Dests', '/OCProperties']);
const INERT_NAME_TREES = new Set(['/Dests', '/JavaScript']);
function assertInertDocument(document) {
  const refuse = () => { throw invalid('This PDF carries actions, scripts, attachments or restrictions the reviewed original does not. Upload the untouched original form.'); };
  if (document.catalog.keys().some((key) => !INERT_CATALOG_KEYS.has(key.toString()))) refuse();
  const names = document.catalog.lookup(PDFName.of('Names'));
  if (names instanceof PDFDict && names.keys().some((key) => !INERT_NAME_TREES.has(key.toString()))) refuse();
  if (document.getPages().some((page) => page.node.get(PDFName.of('AA')) != null)) refuse();
}

function assertOriginalBidForm(document, template, pageNumber) {
  if (document.getPageCount() > 100) throw invalid('Upload the bid-form PDF with no more than 100 pages.');
  if (!Number.isInteger(Number(pageNumber)) || pageNumber < 1 || pageNumber > document.getPageCount()) throw invalid('The selected form page is outside this PDF.');
  const expected = Object.hasOwn(FORM_PAGE_FINGERPRINTS, template) && FORM_PAGE_FINGERPRINTS[template];
  if (!expected) throw invalid('Choose a supported bid form.');
  const page = document.getPage(Number(pageNumber) - 1);
  assertBlankFormState(document, page);
  const actual = pageFingerprint(document, page);
  if (actual.contents !== expected.contents || actual.resources !== expected.resources) throw invalid('This page does not match the supported blank bid form. Select the original form page; revised layouts need a reviewed template.');
  if (packetFingerprint(document, Number(pageNumber) - 1) !== expected.packet) throw invalid('The other pages of this PDF differ from the reviewed original packet. Upload the untouched original form.');
  return page;
}
module.exports = { assertOriginalBidForm, pageContentHash, pageResourceHash, pageFingerprint, packetFingerprint, FORM_PAGE_FINGERPRINTS };
