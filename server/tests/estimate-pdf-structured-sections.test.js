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

const { buildEstimateProposalPDFBuffer } = require('../services/pdf/estimate-pdf');

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
    const untouched = await buildEstimateProposalPDFBuffer(legacyNoTerms, { billsPerApplication: false });
    expect(extractPdfText(untouched)).toContain('callback guarantee between scheduled visits');
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

  test('renders exactly as before when no record is supplied', async () => {
    const buffer = await buildEstimateProposalPDFBuffer(STRUCTURED_ESTIMATE, {});
    const text = extractPdfText(buffer);
    expect(text).not.toContain('SERVICE & PAYMENT AUTHORIZATION');
    expect(text).not.toContain('Accepted electronically');
  });
});
