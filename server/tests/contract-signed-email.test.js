const { buildSignedCopyEmail } = require('../services/contract-signed-email');

describe('contract-signed-email buildSignedCopyEmail', () => {
  const contract = {
    id: 'c1',
    title: 'Termite Retreatment Bond Agreement',
    status: 'signed',
    contract_type: 'document_template',
    contract_text_snapshot: 'Termite Retreatment Bond Agreement\n\nCoverage — retreatment only.',
    signed_name: 'Jane Buyer',
    recipient_initials: 'JB',
    signed_at: '2026-06-23T15:04:00Z',
    signer_ip: '203.0.113.5',
    signer_user_agent: 'Mozilla/5.0',
  };
  const customer = { first_name: 'Jane', last_name: 'Buyer', email: 'jane@example.com' };

  test('builds subject, html, text, and a PDF attachment', async () => {
    const payload = await buildSignedCopyEmail(contract, customer);
    expect(payload.subject).toBe('Your signed copy: Termite Retreatment Bond Agreement');
    expect(payload.html).toContain('Your signed copy');
    expect(payload.html).toContain('Termite Retreatment Bond Agreement');
    expect(payload.text).toContain('Signed by: Jane Buyer');

    expect(payload.attachments).toHaveLength(1);
    const att = payload.attachments[0];
    expect(att.type).toBe('application/pdf');
    expect(att.disposition).toBe('attachment');
    expect(att.filename.endsWith('.pdf')).toBe(true);
    // base64 of a real PDF decodes to a %PDF- header.
    expect(Buffer.from(att.content, 'base64').slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('escapes a title with HTML-special characters and falls back on missing name', async () => {
    const payload = await buildSignedCopyEmail(
      { ...contract, title: 'Repair & <Retreatment> Bond' },
      { email: 'x@example.com' },
    );
    expect(payload.subject).toBe('Your signed copy: Repair & <Retreatment> Bond');
    expect(payload.html).toContain('Repair &amp; &lt;Retreatment&gt; Bond');
    expect(payload.html).toContain('Hi there,');
    // Preheader (hidden inbox preview) must be escaped, not verbatim.
    expect(payload.html).toContain('Your signed copy of Repair &amp; &lt;Retreatment&gt; Bond');
    expect(payload.html).not.toContain('Your signed copy of Repair & <Retreatment> Bond');
  });
});
