// GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK on the pdfkit estimate PDF: one plain "Before you book" page
// from the owner's answer book, only the sections that match what the estimate quotes, never more
// than one added page, and the document exactly as before with the gate off.
const zlib = require('zlib');

jest.mock('../services/pdf/brand-logo', () => ({ getLogoBuffer: () => null }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildEstimateProposalPDFBuffer } = require('../services/pdf/estimate-pdf');
const { detectServices, buildBeforeYouBook, SECTIONS } = require('../services/estimate-before-you-book');

function extractPdfText(buffer) {
  const raw = buffer.toString('latin1');
  const streams = [];
  const re = /stream\r?\n([\s\S]*?)\nendstream/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    try { streams.push(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')); } catch { streams.push(match[1]); }
  }
  const hex = (h) => Buffer.from(h, 'hex').toString('latin1');
  const lines = [];
  for (const stream of streams) {
    for (const tj of stream.matchAll(/\[((?:<[0-9a-fA-F]+>|-?\d+(?:\.\d+)?|\s)+)\]\s*TJ/g)) {
      lines.push([...tj[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((seg) => hex(seg[1])).join(''));
    }
    for (const tj of stream.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) lines.push(hex(tj[1]));
  }
  return lines.join('\n');
}

const pageCount = (buffer) => (buffer.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length;

const fixture = (id, services, oneTime = []) => ({
  id,
  customer_id: 'cust-1',
  category: 'RESIDENTIAL',
  customer_name: 'Sample Customer',
  address: '1 Example Way, Sarasota, FL 34200',
  created_at: '2026-10-22T15:00:00Z',
  estimate_data: { result: { recurring: { services }, oneTime: { items: oneTime } } },
});
const pest = { service: 'pest_control', name: 'Pest Control', visitsPerYear: 4 };
const lawn = { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 };
const termiteBond = { service: 'termite_bond', name: 'Termite Bond', visitsPerYear: 1 };
const rodentTrap = { service: 'rodent', name: 'Rodent Trapping' };

const render = (estimate) => buildEstimateProposalPDFBuffer(estimate, { billsPerApplication: false });
const HEAD = 'BEFORE YOU BOOK';
const PHRASE = {
  scheduling: 'SCHEDULING AND PAYING',
  pest: 'PEST VISITS',
  lawn: 'Your lawn program covers fertilizer',
  termite: 'We do not tent',
  rodent: 'Rodent trapping includes the setup visit',
  contract: 'no long-term contract',
  prepay: 'If you prepay for the year',
  wdo: 'WDO (termite) inspection report',
};

afterEach(() => {
  delete process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK;
  delete process.env.GATE_PREPAY_REFUND_90_DAY;
});

describe('estimate PDF Before you book page', () => {
  test('gate off: no page, same page count and text as the gate-unset document', async () => {
    const est = fixture('byb-off', [pest, lawn]);
    const unset = await render(est);
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'false';
    const off = await render(est);
    expect(pageCount(off)).toBe(pageCount(unset));
    expect(extractPdfText(off)).toBe(extractPdfText(unset));
    expect(extractPdfText(off).toUpperCase()).not.toContain(HEAD);
  });

  test('only exactly "true" turns the gate on', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = '1';
    expect(extractPdfText(await render(fixture('byb-1', [pest]))).toUpperCase()).not.toContain('SCHEDULING AND PAYING');
  });

  test('gate on adds exactly one page and leaves the rest of the document as it was', async () => {
    const est = fixture('byb-on', [pest, lawn]);
    const off = await render(est);
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    const on = await render(est);
    expect(pageCount(on)).toBe(pageCount(off) + 1);
    const offText = extractPdfText(off);
    const onText = extractPdfText(on);
    expect(onText.startsWith(offText)).toBe(true);
    expect(onText).toContain(PHRASE.scheduling);
    expect(onText).toContain('Before you book');
  });

  test('sections appear only for the services the estimate quotes', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    const lawnOnly = extractPdfText(await render(fixture('byb-lawn', [lawn])));
    expect(lawnOnly).toContain(PHRASE.lawn);
    expect(lawnOnly).not.toContain(PHRASE.pest);
    expect(lawnOnly).not.toContain(PHRASE.termite);
    expect(lawnOnly).not.toContain(PHRASE.rodent);

    const pestOnly = extractPdfText(await render(fixture('byb-pest', [pest])));
    expect(pestOnly).toContain(PHRASE.pest);
    expect(pestOnly).not.toContain(PHRASE.lawn);

    const termiteOnly = extractPdfText(await render(fixture('byb-termite', [termiteBond])));
    expect(termiteOnly).toContain(PHRASE.termite);
    expect(termiteOnly).not.toContain(PHRASE.pest);

    const rodentOnly = extractPdfText(await render(fixture('byb-rodent', [], [{ name: 'Rodent Trapping' }])));
    expect(rodentOnly).toContain(PHRASE.rodent);
    expect(rodentOnly).not.toContain(PHRASE.lawn);
    expect(rodentOnly).toContain(PHRASE.scheduling);
  });

  test('the no-contract line needs a residential pest or lawn plan', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    expect(extractPdfText(await render(fixture('byb-c1', [pest])))).toContain(PHRASE.contract);
    expect(extractPdfText(await render(fixture('byb-c2', [termiteBond])))).not.toContain(PHRASE.contract);
    expect(extractPdfText(await render(fixture('byb-c3', [], [{ name: 'Rodent Trapping' }])))).not.toContain(PHRASE.contract);
  });

  test('a commercial or unknown-category estimate never prints the no-contract line, only the neutral agreement line', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    const NEUTRAL = 'follow the agreement you sign';
    // Single building, recurring pest, but category COMMERCIAL: the case a building count would miss.
    const commercial = { ...fixture('byb-com1', [pest]), category: 'COMMERCIAL' };
    const commercialText = extractPdfText(await render(commercial));
    expect(commercialText).not.toContain(PHRASE.contract);
    expect(commercialText).not.toContain('first visit includes an inside spray');
    expect(commercialText).toContain(NEUTRAL);
    // No category at all: unknown fails closed.
    const unknown = { ...fixture('byb-com2', [pest]), category: undefined };
    const unknownText = extractPdfText(await render(unknown));
    expect(unknownText).not.toContain(PHRASE.contract);
    expect(unknownText).toContain(NEUTRAL);
    // An authored (enabled) commercial proposal on a RESIDENTIAL-labelled row.
    const authored = fixture('byb-com3', [pest]);
    authored.estimate_data.proposal = { enabled: true, buildings: [{ name: 'Site', lineItems: [{ description: 'Pest Control', unitPrice: 100, frequency: 'monthly' }] }] };
    expect(extractPdfText(await render(authored))).not.toContain(PHRASE.contract);
    // Known residential keeps the claim and drops the neutral line.
    const residentialText = extractPdfText(await render(fixture('byb-res', [pest])));
    expect(residentialText).toContain(PHRASE.contract);
    expect(residentialText).not.toContain(NEUTRAL);
  });

  test('the page is only for an estimate still being decided', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    const open = await render(fixture('byb-open', [pest]));
    const offPages = pageCount(open);
    for (const status of ['accepted', 'declined', 'expired']) {
      const buf = await render({ ...fixture(`byb-${status}`, [pest]), status });
      expect(extractPdfText(buf)).not.toContain(PHRASE.scheduling);
      expect(pageCount(buf)).toBe(offPages - 1);
    }
    const past = await render({ ...fixture('byb-past', [pest]), status: 'sent', expires_at: '2020-01-01T00:00:00Z' });
    expect(extractPdfText(past)).not.toContain(PHRASE.scheduling);
    const live = await render({ ...fixture('byb-live', [pest]), status: 'sent', expires_at: new Date(Date.now() + 86400000).toISOString() });
    expect(extractPdfText(live)).toContain(PHRASE.scheduling);
  });

  test('the prepay refund line needs an annual prepay offer and the 90-day rule live', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    const recurring = fixture('byb-p1', [pest]);
    expect(extractPdfText(await render(recurring))).not.toContain(PHRASE.prepay);
    process.env.GATE_PREPAY_REFUND_90_DAY = 'true';
    expect(extractPdfText(await render(recurring))).toContain(PHRASE.prepay);
    // No recurring line, no prepay offer.
    expect(extractPdfText(await render(fixture('byb-p2', [], [{ name: 'One-Time Pest Control' }])))).not.toContain(PHRASE.prepay);
    // A termite bond rider cannot prepay.
    expect(extractPdfText(await render(fixture('byb-p3', [pest, termiteBond])))).not.toContain(PHRASE.prepay);
  });

  test('the WDO line needs a WDO inspection on the estimate', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    expect(extractPdfText(await render(fixture('byb-w1', [], [{ name: 'WDO Inspection' }])))).toContain(PHRASE.wdo);
    expect(extractPdfText(await render(fixture('byb-w2', [termiteBond])))).not.toContain(PHRASE.wdo);
  });

  test('an estimate with every service type still adds exactly one page, scheduling first', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    process.env.GATE_PREPAY_REFUND_90_DAY = 'true';
    const est = fixture('byb-all', [pest, lawn, termiteBond, rodentTrap], [{ name: 'WDO Inspection' }, { name: 'German Roach Cleanout' }]);
    const gateOffBuf = (() => { delete process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK; return render(est); })();
    const off = await gateOffBuf;
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    const on = await render(est);
    expect(pageCount(on)).toBe(pageCount(off) + 1);
    const text = extractPdfText(on);
    expect(text.indexOf(PHRASE.scheduling)).toBeGreaterThan(-1);
    for (const phrase of [PHRASE.pest, PHRASE.lawn, PHRASE.termite]) {
      expect(text.indexOf(phrase)).toBeGreaterThan(text.indexOf(PHRASE.scheduling));
    }
  });

  test('every-service page stays above the footer: the last drawn line ends before CONTENT_BOTTOM', async () => {
    const PDFDocument = require('pdfkit');
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    process.env.GATE_PREPAY_REFUND_90_DAY = 'true';
    const CONTENT_BOTTOM = 742 - 18;
    const est = fixture('byb-fit', [pest, lawn, termiteBond, rodentTrap], [{ name: 'WDO Inspection' }, { name: 'German Roach Cleanout' }]);
    const off = (() => { delete process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK; return render(est); })();
    const offBuf = await off;
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    // Record every text call with the page it landed on and the height it takes.
    const calls = [];
    const original = PDFDocument.prototype.text;
    const spy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function recorded(text, x, y, opts) {
      const height = typeof y === 'number' ? this.heightOfString(String(text), opts || {}) : 0;
      calls.push({ page: this.page, y, height, text: String(text) });
      return original.call(this, text, x, y, opts);
    });
    let buf;
    try { buf = await render(est); } finally { spy.mockRestore(); }
    expect(pageCount(buf)).toBe(pageCount(offBuf) + 1);
    const lastPage = calls[calls.length - 1].page;
    const body = calls.filter((c) => c.page === lastPage && typeof c.y === 'number' && c.y < 742);
    expect(body.length).toBeGreaterThan(8);
    const bottom = Math.max(...body.map((c) => c.y + c.height));
    expect(bottom).toBeLessThanOrEqual(CONTENT_BOTTOM);
  });

  test('page text has no dollar sign, "safe", EPA or banned wording', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    process.env.GATE_PREPAY_REFUND_90_DAY = 'true';
    const est = fixture('byb-copy', [pest, lawn, termiteBond, rodentTrap], [{ name: 'WDO Inspection' }, { name: 'German Roach Cleanout' }]);
    const text = extractPdfText(await render(est));
    const bybText = text.slice(text.indexOf('Before you book'));
    expect(bybText.length).toBeGreaterThan(200);
    expect(bybText).not.toMatch(/\$/);
    expect(bybText).not.toMatch(/\bsafe/i);
    expect(bybText).not.toMatch(/\bEPA\b/);
  });
});

describe('Before you book copy', () => {
  const everything = detectServices({
    rows: [{ key: 'pest_control' }, { key: 'lawn_care' }, { key: 'termite_bond_1' }, { key: 'rodent' }],
    items: ['Pest Control', 'Lawn Care', 'Termite Bond', 'Rodent Trapping', 'WDO Inspection', 'German Roach Cleanout'],
  });
  const page = buildBeforeYouBook(everything, { prepayRefundOffered: true, phone: '(941) 555-0100' });
  const allLines = [...SECTIONS.flatMap((s) => s.lines.map((l) => l.text)), ...page.sections.flatMap((s) => s.lines.map((l) => l.text)), page.closing.text];

  test('every line follows the answer book rules', () => {
    for (const text of allLines) {
      expect(text).not.toMatch(/\$|\d+\s*(minutes?|mins?|hours?)\s+(to|before|until|after)\s+(dry|re-?enter)/i);
      expect(text).not.toMatch(/\bsafe/i);
      expect(text).not.toMatch(/\bEPA\b/);
      expect(text).not.toMatch(/& Lawn Care/i);
      expect(text).not.toMatch(/\b(termidor|bifen|talstar|demand cs|celsius|bora-?care)\b/i);
      expect(text).not.toMatch(/\b(thirty|twenty|\d+)\s*minutes?\b/i);
    }
  });

  test('the repo banned-copy screens pass every line', () => {
    // The same screens the texting agent runs on customer copy: "safe" claims, fixed dry or re-entry times, EPA.
    const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
    const { hasBannedCustomerCopy } = require('../services/sms-shadow-drafter');
    expect(typeof findBannedCustomerCopy).toBe('function');
    expect(typeof hasBannedCustomerCopy).toBe('function');
    expect(allLines.length).toBeGreaterThan(20);
    for (const text of allLines) {
      expect(findBannedCustomerCopy(text) || []).toEqual([]);
      expect(hasBannedCustomerCopy(text)).toBe(false);
    }
    // The screen is live: it does flag a "safe" claim.
    expect(hasBannedCustomerCopy('The treatment is safe for pets.')).toBe(true);
  });

  test('sections and ranks: scheduling always, others by service', () => {
    expect(buildBeforeYouBook(detectServices({}), {}).sections.map((s) => s.key)).toEqual(['scheduling']);
    expect(page.sections.map((s) => s.key)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
    for (const section of SECTIONS) for (const line of section.lines) expect([1, 2, 3, 4, 5]).toContain(line.rank);
  });

  test('a lawn line that mentions pest in passing does not turn on the pest section', () => {
    expect(detectServices({ rows: [], items: ['Lawn Pest and Weed Control'] }).pest).toBe(false);
  });
});

describe('Before you book trim and payload block', () => {
  const { trimByRank, beforeYouBookBlock } = require('../services/estimate-before-you-book');
  const page = {
    title: 'Before you book',
    sections: [
      { key: 'a', heading: 'A', lines: [{ rank: 1, text: 'a1' }, { rank: 5, text: 'a5' }] },
      { key: 'b', heading: 'B', lines: [{ rank: 5, text: 'b5' }, { rank: 2, text: 'b2' }] },
    ],
    closing: { rank: 3, text: 'close' },
  };
  const opts = (available) => ({ lineHeight: () => 10, headingH: 20, closingGap: 5, available });

  test('nothing is dropped when the page fits', () => {
    const out = trimByRank(page, opts(1000));
    expect(out.sections.map((s) => s.lines.length)).toEqual([2, 2]);
    expect(out.closing.text).toBe('close');
  });

  test('highest rank goes first, the later line inside a rank first, then an empty section loses its heading', () => {
    // total = 2*20 + 4*10 + 15 = 95
    // Both rank-5 lines are candidates: the one printed later (b5) goes first.
    expect(trimByRank(page, opts(90)).sections.map((s) => s.lines.map((l) => l.text))).toEqual([['a1', 'a5'], ['b2']]);
    // Then a5; then the closing line (rank 3) before the rank-2 line above it.
    const tight = trimByRank(page, opts(65));
    expect(tight.closing).toBeNull();
    expect(tight.sections.map((s) => s.lines.map((l) => l.text))).toEqual([['a1'], ['b2']]);
    const tighter = trimByRank(page, opts(35));
    expect(tighter.sections.map((s) => s.lines.map((l) => l.text))).toEqual([['a1']]);
  });

  test('the payload block is empty with the gate off and fits the estimate with it on', () => {
    const est = fixture('byb-block', [pest, lawn]);
    expect(beforeYouBookBlock(est)).toEqual({});
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    const block = beforeYouBookBlock(est).beforeYouBook;
    expect(block.sections.map((s) => s.key)).toEqual(['scheduling', 'pest', 'lawn']);
    expect(block.sections.every((s) => s.lines.every((l) => typeof l === 'string'))).toBe(true);
  });
});
