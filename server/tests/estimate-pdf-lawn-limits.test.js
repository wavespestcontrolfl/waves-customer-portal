// GATE_ESTIMATE_LAWN_LIMITS on the pdfkit fallback PDF (customer download, admin download,
// email attachment): the same "What we can and can't fix" copy the page prints, only on a
// recurring lawn estimate, only with the gate on, and no dollar amount of its own.
const zlib = require('zlib');

jest.mock('../services/pdf/brand-logo', () => ({ getLogoBuffer: () => null }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const limits = require('../services/estimate-lawn-limits');
const { buildEstimateProposalPDFBuffer } = require('../services/pdf/estimate-pdf');

function extractPdfText(buffer) {
  const raw = buffer.toString('latin1');
  const streams = [];
  // pdfkit writes `stream\n<bytes>\nendstream`. Do NOT swallow an optional \r
  // before the closing `\nendstream`: when the deflate stream's last byte (the
  // Adler-32 low byte) is 0x0D, that would drop it, inflateSync would throw
  // "unexpected end of file", and the helper would return no text at all. Which
  // fixtures hit that depends on the rendered bytes (e.g. the printed date), so
  // it failed on one calendar day only.
  const re = /stream\r?\n([\s\S]*?)\nendstream/g;
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


const lawnEstimate = () => ({
  id: 'fixture-lawn-limits-1',
  customer_id: 'cust-1',
  customer_name: 'Sample Customer',
  address: '1 Example Way, Sarasota, FL 34200',
  created_at: '2026-10-22T15:00:00Z',
  estimate_data: { result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6 }] } } },
});
const pestEstimate = () => ({
  ...lawnEstimate(),
  id: 'fixture-pest-1',
  estimate_data: { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', visitsPerYear: 4 }] } } },
});

// The fake database: the customer's properties (one primary by default), the turf profile row,
// and the customer's legacy lawn text.
function profileRow(row, { props = [{ id: 'prop-a', is_primary: true }], lawnType = null } = {}) {
  db.mockImplementation((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.select = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'customer_turf_profiles' ? row : table === 'customers' ? { lawn_type: lawnType } : undefined));
    q.then = (resolve, reject) => Promise.resolve(table === 'customer_properties' ? props : []).then(resolve, reject);
    return q;
  });
}
const render = async (estimate) => extractPdfText(await buildEstimateProposalPDFBuffer(estimate, { billsPerApplication: false }));
// Long paragraphs wrap and kern across text operators, so match on a short stable phrase.
const PHRASE = {
  always: "What we can and can't fix".toUpperCase(),
  fixed: 'dollarweed out of St. Augustine',
  carpetgrass: 'Part of your lawn is carpetgrass',
  torpedograss: 'We saw torpedograss in your lawn',
  virus: 'yellow streaks that look like a virus',
};

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { delete process.env.GATE_ESTIMATE_LAWN_LIMITS; });

describe('estimate-pdf lawn limits (pdfkit fallback)', () => {
  test('gate off: nothing printed and the profile is never read', async () => {
    profileRow({ other_grasses: ['carpetgrass'], virus_streaks_suspected: true });
    const text = await render(lawnEstimate());
    expect(text).not.toContain(PHRASE.always);
    expect(text).not.toContain(PHRASE.carpetgrass);
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on, non-lawn estimate: nothing printed', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    profileRow({ other_grasses: ['carpetgrass'], virus_streaks_suspected: true });
    const text = await render(pestEstimate());
    expect(text).not.toContain(PHRASE.always);
    expect(text).not.toContain(PHRASE.virus);
  });

  test('gate on, lawn estimate, no flags: the heading and the fixed paragraph only', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    profileRow(undefined);
    const text = await render(lawnEstimate());
    expect(text).toContain(PHRASE.always);
    expect(text).toContain(PHRASE.fixed);
    expect(text).not.toContain(PHRASE.carpetgrass);
    expect(text).not.toContain(PHRASE.virus);
  });

  test('gate on, lawn estimate, flags: one line per flag after the fixed paragraph', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    profileRow({ other_grasses: ['carpetgrass', 'torpedograss'], virus_streaks_suspected: true });
    const text = await render(lawnEstimate());
    expect(text).toContain(PHRASE.fixed);
    expect(text).toContain(PHRASE.carpetgrass);
    expect(text).toContain(PHRASE.torpedograss);
    expect(text).toContain(PHRASE.virus);
    expect(text).not.toContain('We saw bahiagrass');
    expect(text.indexOf(PHRASE.fixed)).toBeLessThan(text.indexOf(PHRASE.carpetgrass));
  });

  test('the module still prints exactly what the page payload carries', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    profileRow({ other_grasses: ['bahiagrass'], virus_streaks_suspected: false });
    const block = await limits.lawnLimitsForEstimate(lawnEstimate());
    expect(block.paragraphs.map((p) => p.key)).toEqual(['always', 'bahiagrass']);
    expect(await render(lawnEstimate())).toContain('We saw bahiagrass mixed into your St. Augustine');
  });

  test('a bermuda or zoysia lawn gets no block at all', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    for (const grass of ['bermuda', 'zoysia']) {
      profileRow({ grass_type: grass, other_grasses: ['carpetgrass'], virus_streaks_suspected: true });
      const text = await render(lawnEstimate());
      expect(text).not.toContain(PHRASE.always);
      expect(text).not.toContain(PHRASE.fixed);
    }
  });

  test('an estimate for a property the profile does not speak for prints the fixed paragraph only', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const props = [{ id: 'prop-a', is_primary: true }, { id: 'prop-b', is_primary: false }];
    profileRow({ other_grasses: ['carpetgrass'], virus_streaks_suspected: true }, { props });
    const text = await render({ ...lawnEstimate(), property_id: 'prop-b' });
    expect(text).toContain(PHRASE.fixed);
    expect(text).not.toContain(PHRASE.carpetgrass);
    expect(text).not.toContain(PHRASE.virus);
  });
});
