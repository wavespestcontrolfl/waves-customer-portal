const { buildContractPDFBuffer, splitBoldLines } = require('../services/pdf/contract-pdf');

describe('contract-pdf', () => {
  const baseContract = {
    id: 'c1',
    title: 'Termite Retreatment Bond Agreement',
    status: 'sent',
    contract_text_snapshot: [
      'Termite Retreatment Bond Agreement',
      '',
      'Coverage — retreatment only: Waves Pest Control, LLC warrants the covered termite treatment.',
      'Annual renewal: This bond must be renewed each year to keep retreatment coverage active.',
    ].join('\n'),
    esign_disclosure_snapshot: 'I agree to receive and sign this document electronically.',
    shared_at: '2026-06-23',
    created_at: '2026-06-23',
  };
  const customer = { first_name: 'Jane', last_name: 'Buyer', company_name: null };

  async function isPdf(buf) {
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(800);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  }

  test('a line wrapped in ** is a bold line (F.S. 482.227 bold statements); others stay as written', () => {
    expect(splitBoldLines('**RETREATMENT ONLY.**\nPlain line\n\n  **EXCLUSIONS**  ')).toEqual([
      { text: 'RETREATMENT ONLY.', bold: true },
      { text: 'Plain line', bold: false },
      { text: '', bold: false },
      { text: 'EXCLUSIONS', bold: true },
    ]);
    expect(splitBoldLines('a ** b ** c')).toEqual([{ text: 'a ** b ** c', bold: false }]);
  });

  test('builds a PDF for a body with bold lines', async () => {
    const buf = await buildContractPDFBuffer({
      ...baseContract,
      contract_text_snapshot: '**RETREATMENT ONLY. THIS WARRANTY DOES NOT COVER DAMAGE REPAIR.**\n\nPlain clause.\n**EXCLUSIONS**\n- Drywood termites.',
    }, customer, { signed: false });
    await isPdf(buf);
  });

  test('builds a review-copy PDF for an unsigned contract', async () => {
    const buf = await buildContractPDFBuffer(baseContract, customer, { signed: false });
    await isPdf(buf);
  });

  test('builds an executed-copy PDF with signature details', async () => {
    const signed = {
      ...baseContract,
      status: 'signed',
      signed_name: 'Jane Buyer',
      recipient_initials: 'JB',
      signed_at: '2026-06-23T15:04:00Z',
      signer_ip: '203.0.113.5',
      signer_user_agent: 'Mozilla/5.0 (iPhone)',
    };
    const buf = await buildContractPDFBuffer(signed, customer, { signed: true });
    await isPdf(buf);
  });

  test('a bold body keeps the 10.5pt body size on every line after a page break', async () => {
    const PDFDocument = require('pdfkit');
    const sizes = new Map();
    const original = PDFDocument.prototype.text;
    PDFDocument.prototype.text = function text(...args) {
      if (typeof args[0] === 'string' && args[0].startsWith('Clause ')) sizes.set(args[0], this._fontSize);
      return original.apply(this, args);
    };
    try {
      const body = ['**HEADING**', ...Array.from({ length: 300 }, (_, i) => `Clause ${i}.`)].join('\n');
      await isPdf(await buildContractPDFBuffer({ ...baseContract, contract_text_snapshot: body }, customer, { signed: false }));
    } finally {
      PDFDocument.prototype.text = original;
    }
    expect(sizes.size).toBe(300);
    expect([...new Set(sizes.values())]).toEqual([10.5]);
  });

  test('a wrapped line that crosses a page break keeps the body size', async () => {
    const PDFDocument = require('pdfkit');
    const sizes = new Set();
    const original = PDFDocument.prototype._fragment;
    PDFDocument.prototype._fragment = function fragment(text, ...rest) {
      if (/wordy/.test(text)) sizes.add(this._fontSize);
      return original.call(this, text, ...rest);
    };
    try {
      const body = ['**HEADING**', 'wordy '.repeat(6000)].join('\n');
      await isPdf(await buildContractPDFBuffer({ ...baseContract, contract_text_snapshot: body }, customer, { signed: false }));
    } finally {
      PDFDocument.prototype._fragment = original;
    }
    expect([...sizes]).toEqual([10.5]);
  });

  test('does not throw on a long body that spans multiple pages', async () => {
    const long = { ...baseContract, contract_text_snapshot: 'Section.\n\n'.repeat(400) };
    const buf = await buildContractPDFBuffer(long, customer, { signed: false });
    await isPdf(buf);
  });

  test('tolerates a missing customer record (falls back to signed name)', async () => {
    const buf = await buildContractPDFBuffer({ ...baseContract, signed_name: 'Pat Owner' }, {}, {});
    await isPdf(buf);
  });

  test('renders a view-only document-template contract (no signature block)', async () => {
    const viewOnly = {
      ...baseContract,
      title: 'Bora-Care Wood Treatment — Treatment Outline',
      contract_type: 'document_template',
      requires_signature_snapshot: false,
      esign_disclosure_snapshot: null,
    };
    const buf = await buildContractPDFBuffer(viewOnly, customer, {});
    await isPdf(buf);
  });

  test('renders with a recipient-name override', async () => {
    const override = { ...baseContract, contract_type: 'document_template', recipient_name: 'Acme Property Mgmt' };
    const buf = await buildContractPDFBuffer(override, customer, {});
    await isPdf(buf);
  });

  describe('certified-operator countersignature line (termite annual, A-14 owner ruling 2026-09-25)', () => {
    const PDFDocument = require('pdfkit');
    let textSpy;
    beforeEach(() => { textSpy = jest.spyOn(PDFDocument.prototype, 'text'); });
    afterEach(() => { textSpy.mockRestore(); });
    const drawn = () => textSpy.mock.calls.map((call) => String(call[0]));

    const signedAnnual = {
      ...baseContract,
      contract_type: 'document_template',
      document_template_key: 'service_agreement.termite_annual_protection',
      status: 'signed',
      signed_name: 'Jane Buyer',
      signed_at: '2026-09-24T15:04:00Z',
    };

    test('stamps "Certified Operator: <name>, <date>" once countersigned', async () => {
      const buf = await buildContractPDFBuffer({
        ...signedAnnual,
        countersigned_at: '2026-09-25T14:00:00Z',
        countersigner_name: 'Adam Owner',
      }, customer, { signed: true });
      await isPdf(buf);
      expect(drawn()).toContain('Certified Operator: Adam Owner, September 25, 2026');
    });

    test('draws no countersignature line (and no blank operator ink line) before it is countersigned', async () => {
      await buildContractPDFBuffer(signedAnnual, customer, { signed: true });
      await buildContractPDFBuffer({ ...signedAnnual, status: 'sent', signed_name: null, signed_at: null }, customer, { signed: false });
      expect(drawn().some((text) => text.includes('Certified Operator'))).toBe(false);
    });
  });
});
