process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const fs = require('fs');
const path = require('path');
const PDFKit = require('pdfkit');
const { PDFDocument } = require('pdf-lib');

const { buildPassJson } = require('../services/wallet-pass');
const { buildPayerStatementPDFBuffer } = require('../services/pdf/payer-statement-pdf');
const { buildInvoicePDFBuffer, buildReceiptPDFBuffer } = require('../services/pdf/invoice-pdf');
const { renderPrepGuidePdf } = require('../services/pdf/prep-guide-pdf');
const { renderServiceDetailsPdf } = require('../services/pdf/service-details-pdf');
const { buildWdoReportPDFBuffer } = require('../services/pdf/wdo-report-pdf');
const { buildContractPDFBuffer } = require('../services/pdf/contract-pdf');
const { renderConfirmPage } = require('../routes/public-newsletter');

describe('PR 2 server HTML, PDFs, compliance docs & Apple Wallet audit regressions', () => {
  test('estimate-public.js removes forbidden priority-scheduling claims, escapes script JSON/DOM sinks, and sets lang/noindex', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');
    expect(src).not.toContain('Priority scheduling — you jump the queue');
    expect(src).not.toContain('priority service');
    expect(src).toContain('function safeJsonForScript(');
    expect(src).toContain("const escHtml = (v) =>");
    expect(src).toContain("escHtml(s.slotId)");
    expect(src).toContain("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Estimate Expired");
    expect(src).toContain("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Estimate Not Found");
    expect(src).toContain(".set('X-Robots-Tag', 'noindex')");
    expect(src).toContain('sendEstimatePageHtml(res, renderEstimateNotFoundPage(), 404)');
    expect(src).toContain('renderExpiredPage({');
    expect(src).not.toContain("res.status(404).set('Content-Type', 'text/html').send(renderEstimateNotFoundPage())");
    expect(src).not.toContain("res.set('Content-Type', 'text/html').send(\n        renderExpiredPage(");
  });

  test('public-newsletter.js renderConfirmPage sets noindex + AA link contrast and expired POST uses expired heading', () => {
    const html = renderConfirmPage('Link expired or invalid.', '<p>Expired</p>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('a { color: #065A8C; }');

    const src = fs.readFileSync(path.join(__dirname, '../routes/public-newsletter.js'), 'utf8');
    expect(src).toContain(`const heading = sub ? "You're unsubscribed." : 'Link expired or invalid.';`);
    expect(src).toContain("'X-Robots-Tag': 'noindex'");
    expect(src).toContain("'Cache-Control': 'no-store'");
  });

  test('wallet-pass buildPassJson keeps stable office phone (never embeds a reassignable tech line)', () => {
    const pass = buildPassJson({
      card: { id: 'card-1' },
      customerFirstName: 'Jordan',
      memberSinceYear: 2026,
      techName: 'Sam Rivera',
      location: { id: 'bradenton', phone: '(941) 297-5749', phoneRaw: '+19412975749' },
      reviewUrl: 'https://portal.wavespestcontrol.com/l/abc',
      referralUrl: 'https://portal.wavespestcontrol.com/r/JORDAN',
      portalUrl: 'https://portal.wavespestcontrol.com',
      cardUrl: 'https://portal.wavespestcontrol.com/card/tok1',
    });
    expect(pass.generic.auxiliaryFields[0].value).toBe('(941) 297-5749');
    const cardField = pass.generic.backFields.find((f) => f.key === 'card');
    expect(cardField.value).toBe('https://portal.wavespestcontrol.com/card/tok1');
  });

  test('card-public.js mounts noStore ahead of rate limiting so 404 and 429 responses carry privacy headers', async () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    expect(indexSrc).toContain("app.use('/api/card', require('./middleware/no-store').noStore);");

    const express = require('express');
    const cardRouter = require('../routes/card-public');
    const app = express();
    app.use('/api/card', cardRouter);
    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const notFoundRes = await fetch(`${baseUrl}/api/card/not-a-hex-token/contact.vcf`);
      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.headers.get('cache-control')).toContain('no-store');
      expect(notFoundRes.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(notFoundRes.headers.get('referrer-policy')).toBe('no-referrer');

      // Exhaust the per-route 60 req/min limiter and confirm 429 still carries privacy headers.
      let rateLimited = null;
      for (let i = 0; i < 65; i += 1) {
        const res = await fetch(`${baseUrl}/api/card/not-a-hex-token/contact.vcf`);
        if (res.status === 429) {
          rateLimited = res;
          break;
        }
      }
      expect(rateLimited).not.toBeNull();
      expect(rateLimited.headers.get('cache-control')).toContain('no-store');
      expect(rateLimited.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(rateLimited.headers.get('referrer-policy')).toBe('no-referrer');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('payer-statement-pdf and invoice-pdf build valid PDFs with long fields and wire doc.on(error)', async () => {
    const stmtBuf = await buildPayerStatementPDFBuffer({
      statement: {
        id: 9012,
        status: 'sent',
        period_start: '2026-10-01',
        period_end: '2026-10-31',
        finalized_at: '2026-11-01T15:00:00Z',
        terms_snapshot: 'net30',
        due_date: '2026-12-01',
        subtotal: 14250.5,
        tax_amount: 0,
        total: 14250.5,
        invoice_count: 2,
      },
      payer: {
        company_name: 'Sarasota Bayfront Property Management Association LLC',
        billing_address_line1: '1234 Longboat Key Boulevard Suite 400',
        billing_city: 'Sarasota',
        billing_state: 'FL',
        billing_zip: '34236',
        ap_email: 'accounts-payable-team@sarasotabayfront-hoa.example.com',
      },
      lines: [
        { service_date: '2026-10-05', service_type: 'Commercial Rodent & Perimeter Control', customer_name: 'Building A', service_address: '100 Main St', invoice_number: 'INV-2026-1001', total: 7125.25 },
        { service_date: '2026-10-19', service_type: 'Lawn & Ornamental Fertilization', customer_name: 'Building B', service_address: '200 Main St', invoice_number: 'INV-2026-1002', total: 7125.25 },
      ],
    });
    expect(stmtBuf.slice(0, 5).toString()).toBe('%PDF-');
    const stmtDoc = await PDFDocument.load(stmtBuf);
    expect(stmtDoc.getPageCount()).toBeGreaterThanOrEqual(1);

    const inv = {
      invoice_number: 'INV-2026-9999',
      status: 'sent',
      sent_at: '2026-11-20T15:00:00Z',
      due_date: '2026-12-20',
      service_date: '2026-11-20',
      service_type: 'Comprehensive Perimeter Pest Control & Ornamental Shrub Treatment',
      po_number: 'PO-2026-SARASOTA-ESTATES-99182',
      subtotal: 245,
      total: 245,
      line_items: [{ description: 'Quarterly Perimeter Pest Control', quantity: 1, unit_price: 245, amount: 245 }],
      customer: { first_name: 'Alex', last_name: 'Morgan', address_line1: '500 Bay St', city: 'Bradenton', state: 'FL', zip: '34205' },
    };
    const invBuf = await buildInvoicePDFBuffer(inv);
    expect(invBuf.slice(0, 5).toString()).toBe('%PDF-');
    const recBuf = await buildReceiptPDFBuffer({ ...inv, status: 'paid', paid_at: '2026-11-21T15:00:00Z' }, { amount: 245, card_brand: 'visa', card_last_four: '4242' });
    expect(recBuf.slice(0, 5).toString()).toBe('%PDF-');

    const contractBuf = await buildContractPDFBuffer(
      { id: 'c1', contract_number: 'WPC-1', title: 'Pest Agreement', contract_body: 'Standard terms for service.', status: 'signed', signed_at: '2026-11-20T15:00:00Z', signed_name: 'Alex Morgan' },
      inv.customer,
    );
    expect(contractBuf.slice(0, 5).toString()).toBe('%PDF-');

    for (const rel of [
      '../services/pdf/payer-statement-pdf.js',
      '../services/pdf/invoice-pdf.js',
      '../services/pdf/contract-pdf.js',
      '../services/pdf/estimate-pdf.js',
    ]) {
      const pdfSrc = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      expect(pdfSrc).toContain("doc.on('error', reject)");
    }
  });

  test('prep-guide-pdf paginates long paragraphs and oversized unbroken tokens cleanly without PDFKit auto-breaks', async () => {
    const longParagraph = [
      Array.from({ length: 120 }, (_, i) => `Step ${i + 1}: clear baseboards, closets, and pet bowls before your Waves technician arrives.`).join(' '),
      '',
      'Section 2 instruction on its own line.',
      `https://portal.wavespestcontrol.com/prep/${'a'.repeat(5000)}`,
      Array.from({ length: 120 }, (_, i) => `Aftercare ${i + 1}: allow treated surfaces to dry completely before pets re-enter.`).join(' '),
    ].join('\n');
    const addPageStacks = [];
    const printedTexts = [];
    let heightCalls = 0;
    const origAddPage = PDFKit.prototype.addPage;
    const origText = PDFKit.prototype.text;
    const origHeight = PDFKit.prototype.heightOfString;
    PDFKit.prototype.addPage = function patchedAddPage(...args) {
      addPageStacks.push(new Error().stack || '');
      return origAddPage.apply(this, args);
    };
    PDFKit.prototype.text = function patchedText(str, ...rest) {
      if (typeof str === 'string') printedTexts.push(str);
      return origText.call(this, str, ...rest);
    };
    PDFKit.prototype.heightOfString = function patchedHeight(...args) {
      heightCalls += 1;
      return origHeight.apply(this, args);
    };
    let buf;
    try {
      buf = await new Promise((resolve, reject) => {
        const chunks = [];
        const res = {
          setHeader() {},
          write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true; },
          end(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); resolve(Buffer.concat(chunks)); },
          on() {}, once() {}, emit() {},
        };
        try {
          renderPrepGuidePdf({
            title: 'Flea Control Service Prep Guide',
            blocks: [
              { type: 'heading', content: 'Before we arrive' },
              { type: 'paragraph', content: longParagraph },
            ],
            technicianName: 'Sam Rivera',
            customerName: 'Alex Morgan',
            propertyAddress: '500 Bay St, Bradenton, FL 34205',
            fileName: 'prep-guide.pdf',
          }, res);
        } catch (err) {
          reject(err);
        }
      });
    } finally {
      PDFKit.prototype.addPage = origAddPage;
      PDFKit.prototype.text = origText;
      PDFKit.prototype.heightOfString = origHeight;
    }
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    const parsed = await PDFDocument.load(buf);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(4);
    expect(heightCalls).toBeLessThan(180);
    expect(printedTexts).toContain('Section 2 instruction on its own line.');
    expect(printedTexts.some((t) => t.startsWith('https://portal.wavespestcontrol.com/prep/aaa'))).toBe(true);
    // Page 1 is created in PDFDocument constructor; every subsequent page must
    // come from prep-guide-pdf.js (never from PDFKit internal auto-pagination).
    const continuationCalls = addPageStacks.slice(1);
    expect(continuationCalls.length).toBe(parsed.getPageCount() - 1);
    for (const stack of continuationCalls) {
      expect(stack).toContain('prep-guide-pdf.js');
      expect(stack).not.toContain('continueOnNewPage');
    }
  });

  test('service-details-pdf emits continuation masthead on multi-page tables and wdo-report-pdf fits long continuation headers', async () => {
    const sdSrc = fs.readFileSync(path.join(__dirname, '../services/pdf/service-details-pdf.js'), 'utf8');
    expect(sdSrc).toContain("top = drawFieldContinuationMasthead(doc, { title: 'Service details · continued' });");
    const sdBuf = await renderServiceDetailsPdf({
      title: 'Pest Service Guide',
      subtitle: 'What to expect',
      sections: [{
        heading: 'Schedule',
        table: {
          columns: ['Season', 'Focus', 'Notes'],
          rows: Array.from({ length: 24 }, (_, i) => [`Month ${i + 1}`, 'Perimeter barrier', 'Inspect entry points, eaves, and turf edges thoroughly for activity.']),
        },
      }],
    });
    expect(sdBuf.slice(0, 5).toString()).toBe('%PDF-');
    const sdDoc = await PDFDocument.load(sdBuf);
    expect(sdDoc.getPageCount()).toBeGreaterThanOrEqual(2);

    const longDamage = Array.from({ length: 120 }, (_, i) => `Damage item ${i + 1} along subfloor joist segment with frass accumulation;`).join(' ');
    const wdoBuf = await buildWdoReportPDFBuffer({
      project: {
        id: 'proj-1',
        inspection_date: '2026-11-20',
        findings: {
          inspection_date: '2026-11-20',
          property_address: '12345 Very Long Southwest Florida Waterfront Boulevard Building North Unit 402, Bradenton, FL 34205',
          wdo_damage: longDamage,
          comments: longDamage,
        },
      },
      customer: {
        first_name: 'Alex',
        last_name: 'Morgan',
        address_line1: '12345 Very Long Southwest Florida Waterfront Boulevard Building North Unit 402',
        city: 'Bradenton',
        state: 'FL',
        zip: '34205',
      },
    });
    expect(wdoBuf.slice(0, 5).toString()).toBe('%PDF-');
    const wdoDoc = await PDFDocument.load(wdoBuf);
    expect(wdoDoc.getPageCount()).toBeGreaterThanOrEqual(3);
  });
});
