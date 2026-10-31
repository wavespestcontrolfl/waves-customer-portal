// The pdfkit estimate PDF: one plain "Before you book" page
// from the owner's answer book, only the sections that match what the estimate quotes, never more
// than one added page, and the document exactly as before with the gate off.
const zlib = require('zlib');

jest.mock('../services/pdf/brand-logo', () => ({ getLogoBuffer: () => null }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildEstimateProposalPDFBuffer } = require('../services/pdf/estimate-pdf');
const { buildBeforeYouBook, SECTIONS } = require('../services/estimate-before-you-book');

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
  // The proposal rows a real estimate prints (the terms-scope check reads them), beside the engine result.
  estimate_data: {
    result: { recurring: { services }, oneTime: { items: oneTime } },
    proposal: {
      enabled: false,
      buildings: [{
        name: 'Service location',
        lineItems: [
          ...services.map((svc) => ({ description: svc.name, unitPrice: 50, frequency: 'quarterly' })),
          ...oneTime.map((item) => ({ description: item.name, unitPrice: 150, frequency: 'one_time' })),
        ],
      }],
    },
  },
});
const pest = { service: 'pest_control', name: 'Pest Control', visitsPerYear: 4 };
const lawn = { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 };
const termiteBond = { service: 'termite_bond', name: 'Termite Bond', visitsPerYear: 1 };
const rodentTrap = { service: 'rodent', name: 'Rodent Trapping' };

const render = (estimate) => buildEstimateProposalPDFBuffer(estimate, { billsPerApplication: false });
const PHRASE = {
  scheduling: 'SCHEDULING AND PAYING',
  pest: 'IF YOUR ESTIMATE INCLUDES PEST CONTROL',
  lawn: 'Your lawn plan covers fertilizer',
  termite: 'We do not tent',
  rodent: 'Rodent trapping includes the setup visit and the trap checks listed',
  contract: 'no long-term contract',
  prepay: 'If your estimate offers a prepaid year',
  wdo: 'WDO (termite) inspection report',
};

describe('estimate PDF Before you book page', () => {
  test('an open estimate gets exactly one more page than the same estimate once decided', async () => {
    const est = fixture('byb-on', [pest, lawn]);
    const decided = await render({ ...est, status: 'declined' });
    const on = await render(est);
    expect(pageCount(on)).toBe(pageCount(decided) + 1);
    const onText = extractPdfText(on);
    expect(onText).toContain(PHRASE.scheduling);
    expect(onText).toContain('Before you book');
  });

  test('the no-contract line needs a residential pest or lawn plan', async () => {
    expect(extractPdfText(await render(fixture('byb-c1', [pest])))).toContain(PHRASE.contract);
    expect(extractPdfText(await render(fixture('byb-c2', [termiteBond])))).not.toContain(PHRASE.contract);
    expect(extractPdfText(await render(fixture('byb-c3', [], [{ name: 'Rodent Trapping' }])))).not.toContain(PHRASE.contract);
  });

  test('a commercial or unknown-category estimate never prints the no-contract line; without an authored proposal it prints the neutral agreement line', async () => {
    const NEUTRAL = 'follow the agreement you sign';
    // Single building, recurring pest, but category COMMERCIAL and no authored proposal: the case a building count would
    // miss. It keeps the current page (owner 2026-10-24: only an authored proposal reads the commercial page).
    const commercial = { ...fixture('byb-com1', [pest]), category: 'COMMERCIAL' };
    const commercialText = extractPdfText(await render(commercial));
    expect(commercialText).not.toContain(PHRASE.contract);
    expect(commercialText).not.toContain('first visit includes an inside spray');
    expect(commercialText).toContain(NEUTRAL);
    expect(commercialText).toContain('Before you book');
    expect(commercialText).not.toContain('Before you start service');
    // No category at all: unknown fails closed.
    const unknown = { ...fixture('byb-com2', [pest]), category: undefined };
    const unknownText = extractPdfText(await render(unknown));
    expect(unknownText).not.toContain(PHRASE.contract);
    expect(unknownText).toContain(NEUTRAL);
    // An authored (enabled) commercial proposal on a RESIDENTIAL-labelled row.
    const authored = fixture('byb-com3', [pest]);
    authored.estimate_data.proposal = { enabled: true, buildings: [{ name: 'Site', lineItems: [{ description: 'Pest Control', unitPrice: 100, frequency: 'monthly' }] }] };
    const authoredText = extractPdfText(await render(authored));
    expect(authoredText).not.toContain(PHRASE.contract);
    expect(authoredText).toContain('Before you start service');
    // Known residential keeps the claim and drops the neutral line.
    const residentialText = extractPdfText(await render(fixture('byb-res', [pest])));
    expect(residentialText).toContain(PHRASE.contract);
    expect(residentialText).not.toContain(NEUTRAL);
  });

  test('the page is only for an estimate still being decided', async () => {
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

  test('the prepay refund line is conditional ("if your estimate offers a prepaid year") and prints on any open estimate (Codex #6504 r4)', async () => {
    const recurring = fixture('byb-p1', [pest]);
    expect(extractPdfText(await render(recurring))).toContain(PHRASE.prepay);
    // worded conditionally, so it needs no prepay verdict: the same line on any open estimate
    expect(extractPdfText(await render(fixture('byb-p3', [pest, termiteBond])))).toContain(PHRASE.prepay);
  });

  test('an estimate with every service type still adds exactly one page, scheduling first', async () => {
    const est = fixture('byb-all', [pest, lawn, termiteBond, rodentTrap], [{ name: 'WDO Inspection' }, { name: 'German Roach Cleanout' }]);
    const off = await render({ ...est, status: 'declined' });
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
    const CONTENT_BOTTOM = 742 - 18;
    const est = fixture('byb-fit', [pest, lawn, termiteBond, rodentTrap], [{ name: 'WDO Inspection' }, { name: 'German Roach Cleanout' }]);
    const offBuf = await render({ ...est, status: 'declined' });
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
  const page = buildBeforeYouBook({ planTerms: true }, { phone: '(941) 555-0100' });
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

  test('every section prints, each service section worded as "if your estimate includes" (Codex #6504 r3)', () => {
    expect(buildBeforeYouBook({}, {}).sections.map((s) => s.key)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
    expect(page.sections.map((s) => s.key)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
    for (const section of page.sections.slice(1)) expect(section.heading).toMatch(/^If your estimate includes /);
    // no package-specific visit counts and no nest promise beyond the small ones
    expect(JSON.stringify(page)).not.toMatch(/two visits for one price|hornet nests on the house are included/);
    // the no-contract line and the plan-only inside line follow the terms verdict; neutral line otherwise
    const neutral = JSON.stringify(buildBeforeYouBook({ planTerms: false }, {}));
    expect(neutral).not.toMatch(/no long-term contract|first visit includes an inside spray/);
    expect(neutral).toMatch(/follow the agreement you sign/);
    for (const section of SECTIONS) for (const line of section.lines) expect([1, 2, 3, 4, 5]).toContain(line.rank);
  });

});

describe('Before you book: terms scope, prepay verdict, structured service keys', () => {
  const { beforeYouBookBlock } = require('../services/estimate-before-you-book');
  const NEUTRAL = 'follow the agreement you sign';
  const withProposal = (est, proposal) => ({ ...est, estimate_data: { ...est.estimate_data, proposal } });

  test('a residential pest + lawn estimate mixed with termite or rodent keeps the plan terms off: neutral line only', async () => {
    for (const extra of [termiteBond, rodentTrap]) {
      const text = extractPdfText(await render(fixture(`byb-mix-${extra.service}`, [pest, lawn, extra])));
      expect(text).not.toContain(PHRASE.contract);
      expect(text).toContain(NEUTRAL);
    }
    // Pest + lawn alone is the plan-terms lane: the claim prints and the neutral line does not.
    const plain = extractPdfText(await render(fixture('byb-mix-none', [pest, lawn])));
    expect(plain).toContain(PHRASE.contract);
    expect(plain).not.toContain(NEUTRAL);
  });

  test('the payload block carries the same conditional refund line', async () => {
    const recurring = fixture('byb-pp1', [pest]);
    const lines = () => (beforeYouBookBlock(recurring, { open: true }).beforeYouBook?.sections || []).flatMap((x) => x.lines).join(' ');
    expect(lines()).toContain(PHRASE.prepay);
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

  test('the payload block is empty on a decided estimate and fits an open one', () => {
    const est = fixture('byb-block', [pest, lawn]);
    expect(beforeYouBookBlock({ ...est, status: 'accepted' })).toEqual({});
    const block = beforeYouBookBlock(est).beforeYouBook;
    expect(block.sections.map((s) => s.key)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
    expect(block.sections.every((s) => s.lines.every((l) => typeof l === 'string'))).toBe(true);
  });
});

// Owner 2026-10-24: a KNOWN commercial proposal reads "Before you start service"; residential is byte-identical.
describe('Before you book: commercial page', () => {
  const crypto = require('crypto');
  const { beforeYouBookBlock, beforeYouBookForEstimate } = require('../services/estimate-before-you-book');
  const { normalizeProposal } = require('../services/estimate-proposal');
  const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

  const SCHEDULING = [
    'We set your service day and time with you, around your business hours.',
    'There is no deposit.',
    "Your service agreement runs 12 months and renews each year. Either side can cancel with 30 days' written notice.",
    'We can send a certificate of insurance and name your business as an additional insured on request.',
  ];
  const PEST = [
    'For inside service, someone needs to let us in, or set up access with us ahead of time.',
    'Some activity for up to two weeks after a treatment is normal, as pests are flushed out. If it has not slowed after two weeks, tell us.',
    'Please keep people off treated areas until they are dry.',
    'Before the first visit, tell us about sensitive areas: food handling, equipment, or staff with sensitivities.',
  ];
  const authored = (descriptions, extra = {}) => ({
    ...fixture('byb-auth', []),
    category: 'COMMERCIAL',
    estimate_data: { proposal: { enabled: true, buildings: [{ name: 'Site', lineItems: descriptions.map((description) => ({ description, unitPrice: 100, frequency: 'monthly' })) }], ...extra } },
  });
  const pageOf = (estimate) => beforeYouBookForEstimate(estimate, normalizeProposal(estimate));
  const textsOf = (page) => page.sections.map((section) => ({ key: section.key, heading: section.heading, lines: section.lines.map((line) => line.text) }));

  test('the 12-month agreement line prints only while the proposal terms agree with the agreement (blank or aligned)', () => {
    const AGREEMENT_LINE = SCHEDULING[2];
    const linesOf = (estimate) => textsOf(pageOf(estimate)).find((section) => section.key === 'scheduling').lines;
    // Blank terms: the agreement governs.
    expect(linesOf(authored(['Monthly pest service']))).toContain(AGREEMENT_LINE);
    // Aligned terms (payment term set aside): still prints.
    expect(linesOf(authored(['Monthly pest service'], { commercialTerms: { initialTermMonths: 12 } }))).toContain(AGREEMENT_LINE);
    // Authored custom terms: the line drops so the document does not contradict itself.
    expect(linesOf(authored(['Monthly pest service'], { commercialTerms: { initialTermMonths: 24 } }))).not.toContain(AGREEMENT_LINE);
    expect(linesOf(authored(['Monthly pest service'], { commercialTerms: { cancellation: 'Cancel any time.' } }))).not.toContain(AGREEMENT_LINE);
    // The rest of the scheduling section stays.
    expect(linesOf(authored(['Monthly pest service'], { commercialTerms: { initialTermMonths: 24 } }))).toEqual(SCHEDULING.filter((line) => line !== AGREEMENT_LINE));
  });

  test('the 12-month agreement line needs a recurring service: a one-time-only proposal drops it, a recurring one keeps it', () => {
    const AGREEMENT_LINE = SCHEDULING[2];
    const linesOf = (estimate) => textsOf(pageOf(estimate)).find((section) => section.key === 'scheduling').lines;
    const oneTime = (extra = {}) => authored(['Commercial pest cleanout'], {
      buildings: [{ name: 'Site', lineItems: [{ description: 'Commercial pest cleanout', unitPrice: 400, frequency: 'one_time' }] }], ...extra,
    });
    // One-time only, blank or standard-aligned terms: no term to state.
    expect(linesOf(oneTime())).toEqual(SCHEDULING.filter((line) => line !== AGREEMENT_LINE));
    expect(linesOf(oneTime({ commercialTerms: { initialTermMonths: 12 } }))).not.toContain(AGREEMENT_LINE);
    // Adding a recurring service brings it back; a recurring program counts too.
    expect(linesOf(authored(['Commercial pest cleanout', 'Monthly pest service'], {
      buildings: [{ name: 'Site', lineItems: [
        { description: 'Commercial pest cleanout', unitPrice: 400, frequency: 'one_time' },
        { description: 'Monthly pest service', unitPrice: 100, frequency: 'monthly' },
      ] }],
    }))).toContain(AGREEMENT_LINE);
    expect(linesOf(authored([], { programs: [{ service: 'pest', label: 'Program', frequencyPerYear: 4, pricePerApplication: 100 }], buildings: [] }))).toContain(AGREEMENT_LINE);
    // A recurring proposal with custom terms still drops the line (unchanged).
    expect(linesOf(authored(['Monthly pest service'], { commercialTerms: { initialTermMonths: 24 } }))).not.toContain(AGREEMENT_LINE);
  });

  test('residential output is byte-identical to the page before this change (hash of the original build)', () => {
    // sha256 of JSON.stringify(buildBeforeYouBook(signals, { phone: '(941) 555-0100' })) on origin/main before the commercial page.
    const phone = { phone: '(941) 555-0100' };
    expect(sha(buildBeforeYouBook({ planTerms: true }, phone))).toBe('54326bc1f28b7e713fb8b3cbe284b85daddf91b14b87d662057c5b3b56951461');
    expect(sha(buildBeforeYouBook({ planTerms: false }, phone))).toBe('f6514f9f8c27b27b3895e2ae6e050d786772a1911a9e7e88424ebd094d0dee70');
    // A known residential estimate still reads the residential page end to end.
    const residential = pageOf(fixture('byb-res-same', [pest, lawn]));
    expect(residential.title).toBe('Before you book');
    expect(residential.sections.map((s) => s.key)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
    expect(residential.closing.text).toMatch(/^Questions before you book\?/);
  });

  test('the misting section prints only for an estimate that carries the misting system (owner wording 2026-10-30)', () => {
    const MISTING_LINES = ['The date you pick is your first monthly service visit.', 'We call you to book the install day.', 'The install charge is on your first invoice.'];
    // The signal alone: no signal, or any other value, leaves the page exactly as it was.
    for (const signals of [{ planTerms: true }, { planTerms: false }, { planTerms: true, misting: false }]) {
      expect(buildBeforeYouBook(signals, {}).sections.map((s) => s.key)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
    }
    const withMisting = buildBeforeYouBook({ planTerms: true, misting: true }, { phone: '(941) 555-0100' });
    expect(withMisting.sections.map((s) => s.key)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent', 'misting']);
    const section = withMisting.sections.find((s) => s.key === 'misting');
    expect(section.heading).toBe('If your estimate includes a misting system');
    expect(section.lines.map((l) => l.text)).toEqual(MISTING_LINES);
    // Every other section is untouched by the misting signal.
    expect(sha(buildBeforeYouBook({ planTerms: true }, { phone: '(941) 555-0100' }).sections)).toBe(sha(withMisting.sections.filter((s) => s.key !== 'misting')));

    // End to end on stored estimates: the misting plan row (or the stored misting input) turns it on; nothing else does.
    const misting = { service: 'mosquito_misting', name: 'Mosquito Misting Service Plan', visitsPerYear: 12 };
    expect(pageOf(fixture('byb-misting', [misting])).sections.map((s) => s.key)).toContain('misting');
    expect(pageOf(fixture('byb-pest-misting', [pest, misting])).sections.map((s) => s.key)).toContain('misting');
    const inputOnly = { ...fixture('byb-misting-input', [pest]), estimate_data: { engineInputs: { services: { pest: true, mosquitoMisting: true } } } };
    expect(pageOf(inputOnly).sections.map((s) => s.key)).toContain('misting');
    for (const services of [[pest], [pest, lawn], [{ service: 'mosquito', name: 'Mosquito', visitsPerYear: 12 }]]) {
      expect(pageOf(fixture('byb-no-misting', services)).sections.map((s) => s.key)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
    }
  });

  test('a commercial pest-only proposal prints exactly the approved strings', () => {
    const page = pageOf(authored(['Commercial pest control, monthly service']));
    expect(page.title).toBe('Before you start service');
    expect(page.closing).toBeNull();
    expect(textsOf(page)).toEqual([
      { key: 'scheduling', heading: 'Scheduling and paying', lines: SCHEDULING },
      { key: 'pest', heading: 'If your service includes pest control', lines: PEST },
    ]);
  });

  test('only an enabled authored proposal reads the commercial page; auto-priced commercial and unknown categories keep the current page byte-identical', () => {
    const current = sha(buildBeforeYouBook({ planTerms: false }, { phone: '(941) 297-5749' }));
    for (const category of ['COMMERCIAL', undefined, null, '', 'LAWN']) {
      const estimate = { ...fixture('byb-unk', [pest]), category };
      const page = pageOf(estimate);
      expect(page.title).toBe('Before you book');
      expect(sha(page)).toBe(current);
    }
    // The commercial category with a proposal that is not enabled (the synthesized, auto-priced shape) is the same page.
    const autoPriced = { ...authored(['Commercial pest control']), estimate_data: { proposal: { enabled: false, buildings: [{ name: 'Site', lineItems: [{ description: 'Commercial pest control', unitPrice: 100, frequency: 'monthly' }] }] } } };
    expect(sha(pageOf(autoPriced))).toBe(current);
    // An enabled authored proposal reads the commercial page whatever the row's category label says.
    for (const category of ['COMMERCIAL', 'RESIDENTIAL', undefined]) {
      expect(pageOf({ ...authored(['Commercial pest control']), category }).title).toBe('Before you start service');
    }
  });

  test('termite, rodent and lawn sections print only when the proposal includes that service', () => {
    const keys = (descriptions, extra) => pageOf(authored(descriptions, extra)).sections.map((s) => s.key);
    expect(keys(['Commercial pest control'])).toEqual(['scheduling', 'pest']);
    expect(keys(['Commercial pest control', 'Monthly rate adjustment for the tenant'])).toEqual(['scheduling', 'pest']);
    expect(keys(['Commercial pest control', 'Lawn fertilization and weed control'])).toEqual(['scheduling', 'pest', 'lawn']);
    expect(keys(['Commercial pest control', 'Termite bait monitoring'])).toEqual(['scheduling', 'pest', 'termite']);
    expect(keys(['Commercial pest control', 'Rodent bait stations'])).toEqual(['scheduling', 'pest', 'rodent']);
    // A service program carries its family directly.
    expect(keys([], { programs: [{ service: 'termite', label: 'Program', frequencyPerYear: 4, pricePerApplication: 100 }], buildings: [] })).toEqual(['scheduling', 'termite']);
    // Nothing printed that names a family: no lawn, termite or rodent section, and the pest default prints.
    expect(keys([])).toEqual(['scheduling', 'pest']);
    expect(keys(['Monthly service'])).toEqual(['scheduling', 'pest']);
  });

  test('the pest section prints when pest work is named or no family is detected; lawn-only, termite-only and rodent-only proposals do not get it', () => {
    const keys = (descriptions) => pageOf(authored(descriptions)).sections.map((s) => s.key);
    expect(keys(['Lawn fertilization and weed control'])).toEqual(['scheduling', 'lawn']);
    expect(keys(['Termite bait monitoring'])).toEqual(['scheduling', 'termite']);
    expect(keys(['Rodent bait stations'])).toEqual(['scheduling', 'rodent']);
    expect(keys(['General pest control', 'Lawn care'])).toEqual(['scheduling', 'pest', 'lawn']);
    expect(keys(['Quarterly roach and ant service'])).toEqual(['scheduling', 'pest']);
    expect(keys(['Mosquito reduction'])).toEqual(['scheduling']);
    // A pest program row by family key, and a lawn-only program row.
    const program = (service) => ({ programs: [{ service, label: 'Program', frequencyPerYear: 4, pricePerApplication: 100 }], buildings: [] });
    expect(pageOf(authored([], program('pest'))).sections.map((s) => s.key)).toEqual(['scheduling', 'pest']);
    expect(pageOf(authored([], program('lawn'))).sections.map((s) => s.key)).toEqual(['scheduling', 'lawn']);
  });

  test('a commercial page never prints the two-hour window, card saving, or the lanai and pool cage line', () => {
    const all = authored(['Pest control', 'Lawn care', 'Termite monitoring', 'Rodent trapping']);
    const text = JSON.stringify(pageOf(all));
    expect(text).not.toMatch(/two-hour window|save your card|lanai|pool cage|Questions before you book|prepaid year|13649 Luxe/);
  });

  test('both renderers pick up the commercial page: the browser /data block and the pdfkit PDF', async () => {
    const estimate = authored(['Commercial pest control']);
    const block = beforeYouBookBlock(estimate, { open: true }).beforeYouBook;
    expect(block.title).toBe('Before you start service');
    expect(block.closing).toBeNull();
    expect(block.sections.map((s) => s.lines)).toEqual([SCHEDULING, PEST]);
    const pdfText = extractPdfText(await buildEstimateProposalPDFBuffer(estimate, { billsPerApplication: false }));
    expect(pdfText).toContain('Before you start service');
    expect(pdfText).toContain('There is no deposit.');
    expect(pdfText).toContain('Please keep people off treated areas until they are dry.');
    expect(pdfText).not.toContain('Before you book');
  });

  test('copy rules hold and trimByRank still works with the commercial ranks', () => {
    const page = pageOf(authored(['Pest control', 'Lawn care', 'Termite monitoring', 'Rodent trapping']));
    const { hasBannedCustomerCopy } = require('../services/sms-shadow-drafter');
    for (const section of page.sections) for (const line of section.lines) {
      expect([1, 2, 3, 4, 5]).toContain(line.rank);
      expect(hasBannedCustomerCopy(line.text)).toBe(false);
    }
    const { trimByRank } = require('../services/estimate-before-you-book');
    const fitted = trimByRank(page, { lineHeight: () => 10, headingH: 20, closingGap: 5, available: 120 });
    const kept = fitted.sections.flatMap((s) => s.lines);
    expect(kept.length).toBeLessThan(page.sections.flatMap((s) => s.lines).length);
    expect(fitted.sections[0].lines[0].text).toBe(SCHEDULING[0]);
    expect(fitted.closing).toBeNull();
  });
});
