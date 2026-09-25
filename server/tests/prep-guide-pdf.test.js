// prep-guide-pdf.js: list blocks + inline markdown links.
//
// Same public contract as PrepGuidePage.jsx's client renderer — a "label
// (url)" text rendering (pdfkit text runs don't carry per-substring hit
// regions for wrapped flowing copy), same http/https/mailto/tel allowlist,
// same "unusable scheme stays literal text" fallback.
const { PassThrough } = require('stream');
const PDFDocument = require('pdfkit');
const { renderPrepGuidePdf } = require('../services/pdf/prep-guide-pdf');

function fakeRes() {
  const stream = new PassThrough();
  stream.setHeader = jest.fn();
  return stream;
}

async function renderToBuffer(opts) {
  const res = fakeRes();
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    res.on('end', resolve);
    res.on('error', reject);
  });
  renderPrepGuidePdf(opts, res);
  await done;
  return Buffer.concat(chunks);
}

// Captures every string pdfkit's .text() draws, while still calling through
// to the real implementation (captured in a closure BEFORE the spy replaces
// the prototype method) so layout/pagination behave normally.
function spyOnText() {
  const original = PDFDocument.prototype.text;
  const calls = [];
  const spy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function patched(str, ...rest) {
    calls.push(str);
    return original.call(this, str, ...rest);
  });
  return { spy, calls };
}

afterEach(() => {
  jest.restoreAllMocks();
});

const BASE = {
  title: 'Flea Control Prep Guide',
  technicianName: 'Adam',
  customerName: 'Pat Rivera',
  propertyAddress: '123 Palm Ave, Bradenton, FL',
  fileName: 'Waves_Flea_Control_Prep_Guide.pdf',
};

describe('prep-guide-pdf list blocks + inline links', () => {
  test('streams a well-formed PDF for a mix of block types incl. list', async () => {
    const buf = await renderToBuffer({
      ...BASE,
      blocks: [
        { type: 'heading', content: 'Before we arrive' },
        { type: 'paragraph', content: 'Please read our [prep checklist](https://wavespestcontrol.com/prep) first.' },
        { type: 'list', items: ['Remove pet bowls', 'Clear the garage'] },
        { type: 'details', rows: [{ label: 'Service', value: 'Flea Control' }] },
        { type: 'callout', content: 'Questions? Email [us](mailto:office@wavespestcontrol.com).' },
      ],
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(500);
  });

  test('renders safe markdown links as "label (url)" text', async () => {
    const { calls } = spyOnText();
    await renderToBuffer({
      ...BASE,
      blocks: [
        { type: 'paragraph', content: 'See our [prep checklist](https://wavespestcontrol.com/prep) before we arrive.' },
        { type: 'callout', content: 'Call [our office](tel:+19415550100) any time.' },
        { type: 'details', rows: [{ label: 'Contact', value: 'Email [us](mailto:office@wavespestcontrol.com)' }] },
      ],
    });
    expect(calls).toContain('See our prep checklist (https://wavespestcontrol.com/prep) before we arrive.');
    expect(calls).toContain('Call our office (tel:+19415550100) any time.');
    expect(calls).toContain('Email us (mailto:office@wavespestcontrol.com)');
  });

  test('refuses an unsafe href scheme, leaving the markdown as literal text', async () => {
    const { calls } = spyOnText();
    await renderToBuffer({
      ...BASE,
      blocks: [
        { type: 'paragraph', content: 'Unsafe: [click me](javascript:alert(1)) stays inert.' },
      ],
    });
    expect(calls).toContain('Unsafe: [click me](javascript:alert(1)) stays inert.');
    expect(calls.some((c) => typeof c === 'string' && c.includes('click me ('))).toBe(false);
  });

  test('list block renders a check row per item and drops blank items', async () => {
    const { calls } = spyOnText();
    await renderToBuffer({
      ...BASE,
      blocks: [
        { type: 'list', items: ['Remove pet bowls', '   ', 'Clear the [garage](https://wavespestcontrol.com/garage)'] },
      ],
    });
    // ZapfDingbats '4' = heavy check mark; U+2713 has no glyph in Helvetica.
    const checkmarks = calls.filter((c) => c === '4');
    expect(calls).not.toContain('✓');
    expect(checkmarks).toHaveLength(2);
    expect(calls).toContain('Remove pet bowls');
    expect(calls).toContain('Clear the garage (https://wavespestcontrol.com/garage)');
  });

  test('an empty list block renders no rows and does not throw', async () => {
    const buf = await renderToBuffer({ ...BASE, blocks: [{ type: 'list', items: [] }, { type: 'paragraph', content: 'Still here.' }] });
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
