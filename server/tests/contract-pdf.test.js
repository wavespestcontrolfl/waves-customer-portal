const { buildContractPDFBuffer } = require('../services/pdf/contract-pdf');

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

  test('does not throw on a long body that spans multiple pages', async () => {
    const long = { ...baseContract, contract_text_snapshot: 'Section.\n\n'.repeat(400) };
    const buf = await buildContractPDFBuffer(long, customer, { signed: false });
    await isPdf(buf);
  });

  test('tolerates a missing customer record (falls back to signed name)', async () => {
    const buf = await buildContractPDFBuffer({ ...baseContract, signed_name: 'Pat Owner' }, {}, {});
    await isPdf(buf);
  });
});
