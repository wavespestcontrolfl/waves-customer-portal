// pdfkit fallback parity for structured proposal sections (slice 1A-i).
// The browser-rendered EstimateProposalDocument is the primary renderer, but
// EVERY render failure serves this pdfkit document instead — so the fallback
// must carry the same agreement content: property scope, corrective work
// (whose amounts are inside the totals), customer responsibilities, and the
// structured commercial terms (pre-push codex P0/P1 on the 1A-i diff).

const zlib = require('zlib');

// The embedded logo is a ~1MB binary image stream whose bytes can collide
// with the naive stream-slicing below — the assertions here are about TEXT
// operators, so drop the logo (the headerBar text fallback renders instead).
jest.mock('../services/pdf/brand-logo', () => ({ getLogoBuffer: () => null }));

const {
  buildEstimateProposalEmailAttachment,
  buildEstimateProposalPDFBuffer,
} = require('../services/pdf/estimate-pdf');

// pdfkit deflate-compresses content streams and writes text as hex-encoded
// TJ arrays split at kern pairs (`[<5045> 20 <5354>] TJ`). Inflate each
// stream, then decode every hex segment and rejoin the segments of one TJ
// array so a kerned phrase reads back as the contiguous string it renders as.
function extractPdfText(buffer) {
  const raw = buffer.toString('latin1');
  const streams = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    try {
      streams.push(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'));
    } catch {
      streams.push(match[1]);
    }
  }
  const decodeHex = (hex) => Buffer.from(hex, 'hex').toString('latin1');
  const lines = [];
  for (const stream of streams) {
    for (const tj of stream.matchAll(/\[((?:<[0-9a-fA-F]+>|-?\d+(?:\.\d+)?|\s)+)\]\s*TJ/g)) {
      const segments = [...tj[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((seg) => decodeHex(seg[1]));
      lines.push(segments.join(''));
    }
    for (const tj of stream.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
      lines.push(decodeHex(tj[1]));
    }
    for (const tj of stream.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      lines.push(tj[1]);
    }
  }
  return lines.join('\n');
}

const STRUCTURED_ESTIMATE = {
  id: 'fixture-estimate-1a',
  customer_name: 'Morgan Example',
  address: '600 Sample Plaza Dr, Sarasota, FL 34299',
  created_at: '2026-08-01T15:00:00Z',
  estimate_data: {
    proposal: {
      enabled: true,
      title: 'Commercial Service Proposal',
      preparedFor: 'Morgan Example',
      propertyAddress: '600 Sample Plaza Dr, Sarasota, FL 34299',
      taxRate: 0.07,
      terms: 'Interior visits beyond the schedule are billed per visit.',
      buildings: [{
        name: 'Service location',
        lineItems: [{ description: 'Quarterly pest control', unitPrice: 120, frequency: 'quarterly', taxable: true }],
      }],
      propertyScope: { items: [{ label: 'Units', value: '4 residential units, tenant-occupied' }] },
      correctiveWork: [{
        label: 'German roach cleanout — Units 2 & 4',
        amount: 450,
        taxable: true,
        includes: ['Crack & crevice treatment in both kitchens'],
      }],
      customerResponsibilities: ['Provide unit access with 24-hour tenant notice'],
      commercialTerms: {
        validDays: 30,
        paymentTerms: 'net30',
        initialTermMonths: 0,
        cancellation: '30-day written notice, no cancellation fee',
      },
    },
  },
};

describe('estimate-pdf structured sections (fallback parity)', () => {
  test('fallback document renders every structured section the React document shows', async () => {
    const buffer = await buildEstimateProposalPDFBuffer(STRUCTURED_ESTIMATE, { billsPerApplication: false });
    expect(buffer.slice(0, 5).toString('latin1')).toBe('%PDF-');
    const text = extractPdfText(buffer);

    // Property scope
    expect(text).toContain('PROPERTY SCOPE');
    expect(text).toContain('4 residential units, tenant-occupied');
    // Corrective work rows + includes
    expect(text).toContain('CORRECTIVE WORK');
    expect(text).toContain('German roach cleanout');
    expect(text).toContain('Crack & crevice treatment in both kitchens');
    // Customer responsibilities
    expect(text).toContain('CUSTOMER RESPONSIBILITIES');
    expect(text).toContain('Provide unit access with 24-hour tenant notice');
    // Structured terms as lines + demoted free-text terms. validDays never
    // renders — expires_at is the only validity date (codex 1A-i r1).
    expect(text).toContain('Payment: Net-30');
    expect(text).not.toContain('Proposal valid: 30 days from issue');
    expect(text).toContain('Initial term: None');
    expect(text).toContain('Interior visits beyond the schedule are billed per visit.');
  });

  test('authored terms suppress the canned callback-guarantee line (terms govern — parity with React/SSR)', async () => {
    const structured = await buildEstimateProposalPDFBuffer(STRUCTURED_ESTIMATE, { billsPerApplication: false });
    expect(extractPdfText(structured)).not.toContain('callback guarantee between scheduled visits');
    const legacyNoTerms = {
      ...STRUCTURED_ESTIMATE,
      estimate_data: {
        proposal: {
          enabled: true,
          title: 'Commercial Service Proposal',
          buildings: STRUCTURED_ESTIMATE.estimate_data.proposal.buildings,
        },
      },
    };
    // An authored (enabled) proposal is commercial, and commercial scope is
    // terms-neutral (AGENTS.md estimate truth scope), so even without
    // authored terms it prints no canned callback guarantee.
    const untouched = await buildEstimateProposalPDFBuffer(legacyNoTerms, { billsPerApplication: false });
    expect(extractPdfText(untouched)).not.toContain('callback guarantee between scheduled visits');
    // The rate-review disclosure follows the same rule: never beside
    // authored terms, never on an authored (commercial) proposal.
    expect(extractPdfText(structured)).not.toContain('Rate reviewed yearly');
    expect(extractPdfText(untouched)).not.toContain('Rate reviewed yearly');
  });

  test.each([
    ['rodent', [{ displayName: 'Rodent Bait Stations', monthlyPrice: 40 }], [{ service: 'rodent_bait', name: 'Rodent Bait Stations' }]],
    ['pest + rodent', [{ displayName: 'Pest Control', monthlyPrice: 55 }, { displayName: 'Rodent Bait Stations', monthlyPrice: 40 }],
      [{ service: 'pest_control', name: 'Pest Control' }, { service: 'rodent_bait', name: 'Rodent Bait Stations' }]],
  ])('a synthesized %s proposal is terms-neutral: no canned callback guarantee', async (_name, lineItems, recurringServices) => {
    const neutral = {
      id: `synthesized-${_name.replace(/\W+/g, '-')}`,
      customer_name: 'Pat Example',
      address: '123 Palm Way',
      monthly_total: 95,
      annual_total: 1140,
      onetime_total: 0,
      estimate_data: { lineItems, result: { recurringServices } },
    };
    const text = extractPdfText(await buildEstimateProposalPDFBuffer(neutral, { billsPerApplication: false }));
    expect(text).toContain('Rodent Bait Stations');
    expect(text).not.toContain('callback guarantee between scheduled visits');
  });

  test.each(['Termite trenching', 'WDO inspection'])(
    'a mixed recurring-pest + %s proposal keeps its priced scope but suppresses the fallback guarantee',
    async (oneTimeDescription) => {
      const mixed = {
        ...STRUCTURED_ESTIMATE,
        estimate_data: {
          proposal: {
            enabled: true,
            title: 'Residential Service Proposal',
            buildings: [{
              name: 'Service location',
              lineItems: [
                { description: 'Quarterly pest control', unitPrice: 120, frequency: 'quarterly', taxable: false },
                { description: oneTimeDescription, unitPrice: 1200, frequency: 'one_time', taxable: false },
              ],
            }],
          },
        },
      };
      const buffer = await buildEstimateProposalPDFBuffer(mixed, { billsPerApplication: false });
      const text = extractPdfText(buffer);
      expect(text).toContain('Quarterly pest control');
      expect(text).toContain(oneTimeDescription);
      expect(text).toContain('$1,200.00');
      expect(text).not.toContain('callback guarantee between scheduled visits');
    },
  );

  test('disabled retained termite itemization suppresses guarantees based on the rows the PDF actually renders', async () => {
    const retainedTermite = {
      id: 'disabled-termite-beside-current-pest',
      customer_name: 'Pat Example',
      address: '123 Palm Way',
      monthly_total: 55,
      annual_total: 660,
      onetime_total: 0,
      estimate_data: {
        // These are the ordinary page's current rows. Its policy correctly
        // sees pest only, but normalizeProposal renders the retained stored
        // itemization below, so document policy must classify that itemization.
        result: { recurringServices: [{ service: 'pest_control', name: 'Pest Control' }] },
        proposal: {
          enabled: false,
          buildings: [{
            name: 'Service location',
            note: 'Retained inspection scope',
            lineItems: [{ description: 'Termite trenching', unitPrice: 1200, frequency: 'one_time', taxable: false }],
          }],
        },
      },
    };

    const text = extractPdfText(await buildEstimateProposalPDFBuffer(retainedTermite, { billsPerApplication: false }));
    expect(text).toContain('Termite trenching');
    expect(text).toContain('$1,200.00');
    expect(text).toContain('Retained inspection scope');
    expect(text).not.toContain('callback guarantee between scheduled visits');
    expect(text).not.toContain('Rate reviewed yearly');
  });

  test('an ordinary synthesized pest proposal keeps its callback guarantee and price', async () => {
    const pest = {
      id: 'ordinary-current-pest',
      customer_name: 'Pat Example',
      address: '123 Palm Way',
      monthly_total: 55,
      annual_total: 660,
      onetime_total: 0,
      estimate_data: {
        lineItems: [{ displayName: 'Pest Control', monthlyPrice: 55 }],
        result: { recurringServices: [{ service: 'pest_control', name: 'Pest Control' }] },
      },
    };

    const text = extractPdfText(await buildEstimateProposalPDFBuffer(pest, { billsPerApplication: false }));
    expect(text).toContain('Pest Control');
    expect(text).toContain('$55.00');
    expect(text).toContain('callback guarantee between scheduled visits');
    // Annual rate review disclosure (owner ruling 2026-09-30) prints beside
    // the recurring residential plan terms. (The typographic apostrophe in
    // "days’" is WinAnsi 0x92 in the extracted stream, so match up to it.)
    expect(text).toContain('Rate reviewed yearly after 12 months, 30 days');
  });

  test('a synthesized lawn proposal carries the rate-review disclosure without the pest-only callback line', async () => {
    const lawn = {
      id: 'ordinary-current-lawn',
      customer_name: 'Pat Example',
      address: '123 Palm Way',
      monthly_total: 85,
      annual_total: 1020,
      onetime_total: 0,
      estimate_data: {
        lineItems: [{ displayName: 'Lawn Care Program', monthlyPrice: 85 }],
        result: { recurringServices: [{ service: 'lawn_care', name: 'Lawn Care Program' }] },
      },
    };

    const text = extractPdfText(await buildEstimateProposalPDFBuffer(lawn, { billsPerApplication: false }));
    expect(text).toContain('Lawn Care Program');
    expect(text).not.toContain('callback guarantee between scheduled visits');
    expect(text).toContain('Rate reviewed yearly after 12 months, 30 days');
  });

  test('a one-time-only pest proposal has no scheduled visits: no canned callback guarantee', async () => {
    const oneTime = {
      id: 'synthesized-one-time-pest',
      customer_name: 'Pat Example',
      address: '123 Palm Way',
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 189,
      estimate_data: {
        proposal: {
          enabled: false,
          buildings: [{ name: 'Service location', lineItems: [
            { description: 'One-Time Pest Control', unitPrice: 189, frequency: 'one_time', taxable: false },
          ] }],
        },
      },
    };
    const text = extractPdfText(await buildEstimateProposalPDFBuffer(oneTime, { billsPerApplication: false }));
    expect(text).toContain('One-Time Pest Control');
    expect(text).not.toContain('callback guarantee between scheduled visits');
    // No recurring line ⇒ no rate to review ⇒ no disclosure.
    expect(text).not.toContain('Rate reviewed yearly');
  });

  test('the email attachment entry point applies the same no-guarantee policy', async () => {
    const mixed = {
      ...STRUCTURED_ESTIMATE,
      estimate_data: {
        proposal: {
          enabled: true,
          buildings: [{
            name: 'Service location',
            lineItems: [
              { description: 'Quarterly pest control', unitPrice: 120, frequency: 'quarterly', taxable: false },
              { description: 'Termite trenching', unitPrice: 1200, frequency: 'one_time', taxable: false },
            ],
          }],
        },
      },
    };
    const attachment = await buildEstimateProposalEmailAttachment(mixed, { billsPerApplication: false });
    const attachmentText = extractPdfText(Buffer.from(attachment.content, 'base64'));
    expect(attachmentText).not.toContain('callback guarantee between scheduled visits');
    expect(attachmentText).not.toContain('Rate reviewed yearly');
  });

  test('an oversized corrective row (12 long bullets) paginates instead of overflowing (codex #3297 r2)', async () => {
    const oversized = {
      ...STRUCTURED_ESTIMATE,
      estimate_data: {
        proposal: {
          ...STRUCTURED_ESTIMATE.estimate_data.proposal,
          correctiveWork: [{
            label: 'Full-building corrective program',
            amount: 2500,
            taxable: false,
            includes: Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: ${'detailed remediation work described at length '.repeat(4).trim()}`),
          }],
        },
      },
    };
    const buffer = await buildEstimateProposalPDFBuffer(oversized, { billsPerApplication: false });
    expect(buffer.slice(0, 5).toString('latin1')).toBe('%PDF-');
    const text = extractPdfText(buffer);
    expect(text).toContain('Full-building corrective program');
    expect(text).toContain('Step 12:');
    // Multi-page output — the bullets flow across pages via the continuation
    // header instead of one indivisible over-page row.
    expect((buffer.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('programs-mode proposal renders the programs block in the fallback (slice 1A-ii)', async () => {
    const programsEstimate = {
      ...STRUCTURED_ESTIMATE,
      estimate_data: {
        proposal: {
          enabled: true,
          title: 'Commercial Service Proposal',
          buildings: [],
          programs: [{
            service: 'pest',
            label: 'Quarterly pest program',
            frequencyPerYear: 4,
            pricePerApplication: 120,
            inclusions: ['4 scheduled applications per year'],
            exclusions: ['Termite treatment — separate program'],
            buildings: [{ name: 'Tower A' }],
          }],
        },
      },
    };
    const buffer = await buildEstimateProposalPDFBuffer(programsEstimate, { billsPerApplication: false });
    const text = extractPdfText(buffer);
    expect(text).toContain('SERVICE PROGRAMS');
    expect(text).toContain('Quarterly pest program');
    expect(text).toContain('4 applications per year');
    expect(text).toContain('Covers: Tower A');
    expect(text).toContain('Not included (quoted separately): Termite treatment');
    // Programs carry authored inclusions — no canned guarantee beside them.
    expect(text).not.toContain('callback guarantee between scheduled visits');
  });

  test('legacy proposal renders no structured section labels', async () => {
    const legacy = {
      ...STRUCTURED_ESTIMATE,
      estimate_data: {
        proposal: {
          enabled: true,
          title: 'Commercial Service Proposal',
          buildings: STRUCTURED_ESTIMATE.estimate_data.proposal.buildings,
        },
      },
    };
    const buffer = await buildEstimateProposalPDFBuffer(legacy, { billsPerApplication: false });
    const text = extractPdfText(buffer);
    expect(text).not.toContain('PROPERTY SCOPE');
    expect(text).not.toContain('CORRECTIVE WORK');
    expect(text).not.toContain('CUSTOMER RESPONSIBILITIES');
  });
});

describe('pdfkit fallback — recorded acceptance block', () => {
  const ACCEPTANCE = {
    recordId: 'ACC-ABCD1234',
    termsVersion: 'v2026-09',
    termsText: 'Accepting authorizes these services at the price shown.\nServices — until you cancel. No contract.\nAccepting — counts as your signature.',
    acceptedAt: '2026-08-28T10:35:00Z',
    ipMasked: '203.0.x.x',
    device: 'iPhone · Safari',
  };

  test('prints the verbatim recorded text + stamp when a record is supplied', async () => {
    const buffer = await buildEstimateProposalPDFBuffer(STRUCTURED_ESTIMATE, { acceptance: ACCEPTANCE });
    const text = extractPdfText(buffer);
    expect(text).toContain('SERVICE & PAYMENT AUTHORIZATION');
    expect(text).toContain('Accepting authorizes these services at the price shown.');
    expect(text).toContain('Accepting');
    expect(text).toContain('Terms v2026-09');
    expect(text).toContain('Record ACC-ABCD1234');
    expect(text).toContain('IP 203.0.x.x');
  });

  // Per-page text: pdfkit writes one content stream per page, so the
  // heading and the stamp must land in the SAME stream for any page fill.
  function extractPdfPages(buffer) {
    const raw = buffer.toString('latin1');
    const pages = [];
    const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
      let inflated;
      try { inflated = zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'); } catch { continue; }
      const parts = [];
      for (const tj of inflated.matchAll(/\[((?:<[0-9a-fA-F]+>|-?\d+(?:\.\d+)?|\s)+)\]\s*TJ/g)) {
        parts.push([...tj[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((seg) => Buffer.from(seg[1], 'hex').toString('latin1')).join(''));
      }
      if (parts.length) pages.push(parts.join('\n'));
    }
    return pages;
  }

  test('the block is never split across a page boundary, whatever precedes it', async () => {
    for (const pad of [0, 300, 600, 900, 1200, 1500, 1800]) {
      const estimate = {
        ...STRUCTURED_ESTIMATE,
        estimate_data: {
          ...STRUCTURED_ESTIMATE.estimate_data,
          proposal: { ...STRUCTURED_ESTIMATE.estimate_data.proposal, terms: `${STRUCTURED_ESTIMATE.estimate_data.proposal.terms} ${'Operator term text. '.repeat(pad / 20)}`.trim() },
        },
      };
      const pages = extractPdfPages(await buildEstimateProposalPDFBuffer(estimate, { acceptance: ACCEPTANCE }));
      const withHeading = pages.filter((t) => t.includes('SERVICE & PAYMENT AUTHORIZATION'));
      expect(withHeading).toHaveLength(1);
      expect(withHeading[0]).toContain('Record ACC-ABCD1234');
      expect(withHeading[0]).toContain('Accepting authorizes these services at the price shown.');
    }
  });

  test('renders exactly as before when no record is supplied', async () => {
    const buffer = await buildEstimateProposalPDFBuffer(STRUCTURED_ESTIMATE, {});
    const text = extractPdfText(buffer);
    expect(text).not.toContain('SERVICE & PAYMENT AUTHORIZATION');
    expect(text).not.toContain('Accepted electronically');
  });
});
