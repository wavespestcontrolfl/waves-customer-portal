#!/usr/bin/env node
// Prints the bid-form fingerprint of one page of a PDF (content-stream hash +
// resource hash) and the packet fingerprint of every other page, for
// recording in FORM_PAGE_FINGERPRINTS after a reviewed original changes. Run
// it on the untouched original. Read-only; nothing is uploaded or stored.
//   node server/scripts/bid-form-fingerprint.js <file.pdf> <pageNumber>
const fs = require('node:fs');
const { PDFDocument } = require('pdf-lib');
const { pageFingerprint, packetFingerprint } = require('../services/pdf/proposal-bid-form');

(async () => {
  const [file, pageArg] = process.argv.slice(2);
  if (!file || !pageArg) { console.error('usage: bid-form-fingerprint.js <file.pdf> <pageNumber>'); process.exit(2); }
  const document = await PDFDocument.load(fs.readFileSync(file));
  const page = document.getPage(Number(pageArg) - 1);
  console.log(JSON.stringify({ file, page: Number(pageArg), ...pageFingerprint(document, page), packet: packetFingerprint(document, Number(pageArg) - 1) }, null, 2));
})().catch((err) => { console.error(err.message); process.exit(1); });
