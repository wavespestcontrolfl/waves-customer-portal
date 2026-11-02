// "Your re-service" report block (GATE_RESERVICE_ASKS, step S3a): the pure
// builder, the PDF cache-key parts and the real buildReportV1Data payload.
// Synthetic names and addresses only.

jest.mock('../services/photos', () => ({
  getViewUrl: jest.fn(async (key) => `https://example.test/${key}`),
  CUSTOMER_DWELL_TTL_SECONDS: 3600,
}));

const { buildReportV1Data } = require('../services/service-report/report-data');
const {
  buildReserviceAsksReport,
  reserviceAsksReportApplies,
  reserviceAsksPdfPart,
  reserviceAsksFenceStamp,
} = require('../services/service-report/reservice-asks-report');
const { reserviceReportPdfSignature, reserviceReportRenderedSignature } = require('../services/service-report/reservice-report');
const { reserviceCardRenderFence } = require('../services/service-report/reservice-report-card');

const ENV = ['GATE_RESERVICE_ASKS', 'GATE_RESERVICE_REPORT_COPY', 'GATE_RESERVICE_REPORT_CARD', 'GATE_REPORT_PRODUCT_COPY'];
const ORIGINAL = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

const OFFICE_REASON = 'Owner-only reason: customer upset about the missed window';

function item(overrides = {}) {
  return {
    id: 'text:1',
    source: 'text',
    at: '2026-10-30T14:05:00.000Z',
    text: 'Ants are back in the kitchen.',
    quoted: true,
    lead: null,
    kind: 'problem',
    pests: ['Ants'],
    printable: true,
    ...overrides,
  };
}

function frozen(items, answers, extra = {}) {
  return {
    version: 2, gatheredAt: '2026-11-01T15:00:00.000Z', lane: 'pest', items, answers, officeNotes: {}, ...extra,
  };
}

function service(asks, overrides = {}) {
  return {
    id: 'svc-asks-1', customer_id: 'cust-asks', service_line: 'pest', service_type: 'Pest Control Re-Service',
    service_date: '2026-11-01', is_callback: true, city: 'Parrish',
    service_data: JSON.stringify(asks ? { reserviceAsks: asks } : {}),
    ...overrides,
  };
}

const PRODUCTS = [
  { id: 'sp1', product_id: 'prod-1', product_name: 'Taurus SC', application_area: 'Outside', targets: JSON.stringify(['Ants']) },
  { id: 'sp2', product_id: 'prod-2', product_name: 'Test Product B', application_area: 'Inside', targets: JSON.stringify(['Spiders']) },
  { id: 'sp3', product_id: 'prod-1', product_name: 'Taurus SC', application_area: 'Garage', targets: JSON.stringify(['Ants']) },
];
const BLOCK = { serviceLine: 'pest', outcome: 'treated', expectation: 'Treatments can take several days to knock activity down fully.' };

function on() { process.env.GATE_RESERVICE_ASKS = 'true'; }

describe('reserviceAsksReport builder', () => {
  const treatedAsk = frozen([item()], { 'text:1': { answer: 'treated', productIds: ['prod-1', 'prod-2'] } });

  test('gate off, no freeze, a version-2 freeze, or nothing to show: null', () => {
    delete process.env.GATE_RESERVICE_ASKS;
    expect(buildReserviceAsksReport(service(treatedAsk), { block: BLOCK, products: PRODUCTS })).toBeNull();
    on();
    expect(buildReserviceAsksReport(service(null), { block: BLOCK, products: PRODUCTS })).toBeNull();
    // A version-1 freeze predates the property marker, so it never renders (it may hold another property's texts).
    expect(buildReserviceAsksReport(service({ ...treatedAsk, version: 1 }), { block: BLOCK, products: PRODUCTS })).toBeNull();
    expect(reserviceAsksReportApplies(service({ ...treatedAsk, version: 1 }), BLOCK)).toBe(false);
    expect(buildReserviceAsksReport(service({ ...treatedAsk, version: 3 }), { block: BLOCK, products: PRODUCTS })).toBeNull();
    // An unanswered item is left out; so is a hidden one; so is an office-only one.
    const none = frozen(
      [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c', text: 'You charged me twice and I want a refund.' })],
      { b: { answer: 'hidden' }, c: { answer: 'noted' } },
    );
    expect(buildReserviceAsksReport(service(none), { block: BLOCK, products: PRODUCTS })).toBeNull();
    expect(reserviceAsksReportApplies(service(none))).toBe(false);
  });

  test.each(['inspection_only', 'customer_declined', 'incomplete'])(
    'a %s outcome on the copy block: null, so today\'s card (which claims no treatment) stays',
    (outcome) => {
      on();
      expect(buildReserviceAsksReport(service(treatedAsk), { block: { ...BLOCK, outcome }, products: PRODUCTS })).toBeNull();
      expect(reserviceAsksReportApplies(service(treatedAsk), { ...BLOCK, outcome })).toBe(false);
      expect(reserviceAsksPdfPart(service(treatedAsk), { ...BLOCK, outcome })).toBe('');
    },
  );

  test('no copy block (GATE_RESERVICE_REPORT_COPY off): the freeze rule alone decides, and the block builds', () => {
    on();
    expect(buildReserviceAsksReport(service(treatedAsk), { block: null, products: PRODUCTS })).toMatchObject({ version: 1 });
    expect(reserviceAsksReportApplies(service(treatedAsk), null)).toBe(true);
  });

  test('an account-wide item (several properties) never prints on this property\'s report', () => {
    on();
    const asks = frozen([item({ accountWide: true })], { 'text:1': { answer: 'noted' } });
    expect(buildReserviceAsksReport(service(asks), { block: BLOCK, products: PRODUCTS })).toBeNull();
    const mixed = frozen([item({ id: 'booking:1', source: 'request_form' }), item({ id: 'text:2', accountWide: true })],
      { 'booking:1': { answer: 'noted' }, 'text:2': { answer: 'noted' } });
    expect(buildReserviceAsksReport(service(mixed), { block: BLOCK, products: PRODUCTS }).told.map((row) => row.label)).toEqual(['Request form · Oct 30']);
  });

  test('the quoted words keep only the pest problem: a sentence about a pet, a person, a bait or a health word never prints', () => {
    on();
    const asks = frozen([
      item({ id: 'a', text: 'Our cat gets sick if we let her out on the lanai. Millipedes are all over the lanai.' }),
      item({ id: 'b', text: 'The bait by the sink is gone. Ants are back by the sink.' }),
      item({ id: 'c', text: 'My son has a cough.' }),
    ], { a: { answer: 'noted' }, b: { answer: 'noted' }, c: { answer: 'noted' } });
    const block = buildReserviceAsksReport(service(asks), { block: BLOCK, products: PRODUCTS });
    expect(block.told.map((row) => row.words)).toEqual(['“Millipedes are all over the lanai.”', '“Ants are back by the sink.”', null]);
    // Card 2 names each message by what card 1 printed, never the dropped sentences.
    expect(block.did.map((row) => row.subject)).toEqual([
      'Text · Oct 30 · “Millipedes are all over the lanai”', 'Text · Oct 30 · “Ants are back by the sink”', 'Text · Oct 30',
    ]);
    expect(JSON.stringify(block)).not.toMatch(/cat|bait|cough|son\b/i);
  });

  test('a health complaint never prints: flagged at gather time, or caught again at render', () => {
    on();
    const flagged = frozen([item({ officeOnly: 'health', text: 'Ants are still in the kitchen.' })], { 'text:1': { answer: 'treated', productIds: ['prod-1'] } });
    expect(buildReserviceAsksReport(service(flagged), { block: BLOCK, products: PRODUCTS })).toBeNull();
    const unflagged = frozen([item({ text: 'I got sick after your spray. Ants are still in the kitchen.' })], { 'text:1': { answer: 'treated', productIds: ['prod-1'] } });
    expect(buildReserviceAsksReport(service(unflagged), { block: BLOCK, products: PRODUCTS })).toBeNull();
    const breathe = frozen([item({ text: 'Ants are still in the kitchen. I could not breathe after your spray.' })], { 'text:1': { answer: 'treated', productIds: ['prod-1'] } });
    expect(buildReserviceAsksReport(service(breathe), { block: BLOCK, products: PRODUCTS })).toBeNull();
  });

  test('an item frozen as office-only never shows, even when its scrubbed words read clean', () => {
    on();
    const flagged = frozen([item({ officeOnly: 'billing' })], { 'text:1': { answer: 'noted' } });
    expect(buildReserviceAsksReport(service(flagged), { block: BLOCK, products: PRODUCTS })).toBeNull();
    expect(reserviceAsksReportApplies(service(flagged), BLOCK)).toBe(false);
  });

  test('the card\'s egress screens: a key, remote or fob location and any safety claim never print; a third-person paraphrase never sits under a lead', () => {
    on();
    const asks = frozen([
      item({ id: 'k', text: 'The spare key is under the flower pot beside the ants.' }),
      item({ id: 'r', text: 'Ants by the back door. The garage remote is in the mailbox.' }),
      item({ id: 'p', text: 'Is the bait pet friendly?', kind: 'question' }),
      item({ id: 'o', source: 'office', quoted: false, lead: 'As reported to our office:', text: 'Customer says the ants are back' }),
      item({ id: 'c', source: 'call', quoted: false, lead: 'On your call on Oct 30, you mentioned', text: 'ants in the pantry' }),
    ], {
      k: { answer: 'noted' }, r: { answer: 'noted' }, p: { answer: 'answered', text: 'It is a gel bait placed in cracks out of reach.' },
      o: { answer: 'noted' }, c: { answer: 'noted' },
    });
    const block = buildReserviceAsksReport(service(asks), { block: BLOCK, products: PRODUCTS });
    expect(block.told.map((row) => row.words)).toEqual([
      null,
      '“Ants by the back door.”',
      null,
      null,
      'On your call on Oct 30, you mentioned ants in the pantry',
    ]);
    expect(JSON.stringify(block)).not.toMatch(/flower pot|remote|mailbox|pet friendly|Customer says/);
  });

  test('a typed answer the egress screens would cut drops its row whole', () => {
    on();
    const asks = frozen([item()], { 'text:1': { answer: 'answered', text: 'We baited the kitchen. I left the key under the mat.' } });
    const block = buildReserviceAsksReport(service(asks), { block: BLOCK, products: PRODUCTS });
    expect(block.did).toEqual([]);
    expect(JSON.stringify(block)).not.toMatch(/key|mat\b/);
  });

  test('summary line: singulars, and a clause with a zero count is dropped', () => {
    on();
    const make = (items) => {
      const answers = Object.fromEntries(items.map((it) => [it.id, { answer: 'noted' }]));
      return buildReserviceAsksReport(service(frozen(items, answers)), { block: BLOCK, products: [] }).summary;
    };
    const q = (id) => item({ id, kind: 'question', text: 'Do you treat for ants?' });
    expect(make([item({ id: 'a' }), q('b')])).toBe('You told us about 1 thing and asked 1 question. Here is what we did for each.');
    expect(make([item({ id: 'a' }), item({ id: 'b' }), q('c'), q('d')])).toBe('You told us about 2 things and asked 2 questions. Here is what we did for each.');
    expect(make([q('a')])).toBe('You asked 1 question. Here is what we did for each.');
    expect(make([item({ id: 'a' }), item({ id: 'b' })])).toBe('You told us about 2 things. Here is what we did for each.');
  });

  test('card 1: label with Eastern date, quoted / lead / plain words, and label-only when not printable', () => {
    on();
    const items = [
      item({ id: 'a', source: 'request_form', at: '2026-11-01T02:30:00.000Z' }), // 10:30 PM Oct 31 Eastern
      item({ id: 'b', source: 'call', quoted: false, lead: 'On your call, you mentioned', text: 'ants by the sink.' }),
      item({ id: 'c', source: 'office', quoted: false, lead: 'As reported to our office:', text: 'Spiders on the lanai.' }),
      item({ id: 'd', source: 'email', kind: 'question', text: 'Do you spray the lanai too?' }),
      item({ id: 'e', source: 'text', printable: false, text: 'Is the spray safe for my cat?' }),
      item({ id: 'f', source: 'text', text: 'It is perfectly safe for kids.' }), // fails the screen at render
      item({ id: 'g', source: 'request_form', quoted: false, text: 'Picked: Ants, Spiders' }),
    ];
    const answers = Object.fromEntries(items.map((it) => [it.id, { answer: 'noted' }]));
    const { told } = buildReserviceAsksReport(service(frozen(items, answers)), { block: BLOCK, products: [] });
    expect(told).toEqual([
      { label: 'Request form · Oct 31', words: '“Ants are back in the kitchen.”', quoted: true },
      { label: 'Call · Oct 30', words: 'On your call, you mentioned ants by the sink.', quoted: false },
      { label: 'Office · Oct 30', words: 'As reported to our office: Spiders on the lanai.', quoted: false },
      { label: 'Your question · Oct 30', words: '“Ants are back in the kitchen.”'.replace(/.*/, '“Do you spray the lanai too?”'), quoted: true },
      { label: 'Text · Oct 30', words: null, quoted: true },
      { label: 'Text · Oct 30', words: null, quoted: true },
      { label: 'Request form · Oct 30', words: 'Picked: Ants, Spiders', quoted: false },
    ]);
  });

  test('card 2: treated names the visit products once each; unresolved ids say "today"', () => {
    on();
    const items = [item({ id: 'a' }), item({ id: 'b', pests: ['Fire ants', 'Spiders'], text: 'Fire ants and spiders.' }), item({ id: 'c', pests: [] })];
    const answers = {
      a: { answer: 'treated', productIds: ['prod-1', 'prod-2'] },
      b: { answer: 'treated', productIds: ['prod-9'] },
      c: { answer: 'treated', productIds: ['prod-1'] },
    };
    const { did } = buildReserviceAsksReport(service(frozen(items, answers)), { block: BLOCK, products: PRODUCTS });
    // Each answer names its own message (card 1's label and first words), never only the pest.
    expect(did).toEqual([
      { chip: 'Treated', subject: 'Text · Oct 30 · “Ants are back in the kitchen”', line: 'We treated it with Taurus SC and Test Product B.' },
      { chip: 'Treated', subject: 'Text · Oct 30 · “Fire ants and spiders”', line: 'We treated it today.' },
      { chip: 'Treated', subject: 'Text · Oct 30 · “Ants are back in the kitchen”', line: 'We treated it with Taurus SC.' },
    ]);
  });

  test('card 2: a long message is cut to its first words; a label-only message keeps only its label', () => {
    on();
    const items = [
      item({ id: 'l', text: 'The ants are back along the kitchen counter and the slider again.' }),
      item({ id: 'q', kind: 'question', text: 'Is the bait safe for my cat?' }),
    ];
    const answers = { l: { answer: 'noted' }, q: { answer: 'answered', text: 'It is a gel bait placed in cracks out of reach.' } };
    const { did } = buildReserviceAsksReport(service(frozen(items, answers)), { block: BLOCK, products: PRODUCTS });
    expect(did.map((row) => row.subject)).toEqual(['Text · Oct 30 · “The ants are back along the…”', 'Your question · Oct 30']);
  });

  test('card 2: a lawn report adds "Where"; a pest report names no areas (owner 2026-10-05)', () => {
    on();
    const lawnProducts = [{ id: 'sp1', product_id: 'prod-1', product_name: 'Test Fungicide', application_area: 'Front yard, Back yard' }];
    const ask = (lane) => frozen([item({ pests: [] })], { 'text:1': { answer: 'treated', productIds: ['prod-1'] } }, { lane });
    const lawn = buildReserviceAsksReport(service(ask('lawn')), { block: { ...BLOCK, serviceLine: 'lawn' }, products: lawnProducts });
    expect(lawn.did[0].line).toBe('We treated it with Test Fungicide. Where: the front yard and back yard.');
    expect(lawn.products[0].where).toBe('The front yard and back yard');
    const pest = buildReserviceAsksReport(service(ask('pest')), { block: BLOCK, products: lawnProducts });
    expect(pest.did[0].line).toBe('We treated it with Test Fungicide.');
    expect(pest.products[0].where).toBeNull();
  });

  test('card 2: fixed lines, the office reason never shows, and an answer that fails the screen drops the row', () => {
    on();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const items = ids.map((id) => item({ id, pests: id === 'f' ? [] : ['Millipedes'], source: id === 'f' ? 'office' : 'text', quoted: false, lead: null }));
    const answers = {
      a: { answer: 'checked_none' },
      b: { answer: 'noted' },
      c: { answer: 'not_today' },
      d: { answer: 'answered', text: 'They come in after heavy rain and should fade as it dries.' },
      e: { answer: 'answered', text: 'Yes, it is safe for your pets.' },
      f: { answer: 'noted' },
    };
    const asks = frozen(items, answers, { officeNotes: { c: OFFICE_REASON } });
    const report = buildReserviceAsksReport(service(asks), { block: BLOCK, products: [] });
    expect(report.did.map((row) => [row.chip, row.line])).toEqual([
      ['Checked', 'We checked and found no activity there today.'],
      ['Noted', 'We noted this on your service record.'],
      ['Follow-up', 'We will follow up on this one.'],
      ['Answered', 'They come in after heavy rain and should fade as it dries.'],
      ['Noted', 'We noted this on your service record.'],
    ]);
    // Words that are not quoted (calls, office notes) never get quotation marks in the subject either.
    expect(report.did[0].subject).toBe('Text · Oct 30 · Ants are back in the kitchen');
    expect(report.did[4].subject).toBe('Office · Oct 30 · Ants are back in the kitchen');
    // Card 1 still lists all six items.
    expect(report.told).toHaveLength(6);
    expect(JSON.stringify(report)).not.toContain('missed window');
    expect(JSON.stringify(report)).not.toContain('Owner-only');
  });

  test('card 3: each product once, approved "How it helps" only with the product wording gate; card 4 keeps the expectation and topic', () => {
    on();
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const asks = frozen([item()], { 'text:1': { answer: 'treated', productIds: ['prod-1'] } });
    const report = buildReserviceAsksReport(service(asks), { block: BLOCK, products: PRODUCTS, city: 'Parrish' });
    expect(report.products.map((p) => p.name)).toEqual(['Taurus SC', 'Test Product B']);
    expect(report.products[0].how).toMatch(/walk right through the treated band/);
    expect(report.products[1].how).toBeNull();
    expect(report.expectation).toBe(BLOCK.expectation);
    expect(report.stillSeeing).toBe('ants or spiders');
    delete process.env.GATE_REPORT_PRODUCT_COPY;
    const plain = buildReserviceAsksReport(service(asks), { block: BLOCK, products: PRODUCTS, city: 'Parrish' });
    expect(plain.products.every((p) => p.how === null)).toBe(true);
  });

  test('card 4 without a copy block: no expectation line, topic from the customer\'s own pests', () => {
    on();
    const asks = frozen([item({ pests: ['Roaches'] })], { 'text:1': { answer: 'noted' } });
    const report = buildReserviceAsksReport(service(asks), { block: null, products: [] });
    expect(report.expectation).toBeNull();
    expect(report.stillSeeing).toBe('roaches');
  });
});

describe('PDF cache key and render fence', () => {
  const asks = frozen([item()], { 'text:1': { answer: 'noted' } });
  const member = service(asks, { service_tier: 'Gold', service_tier_source: 'manual' });
  const plain = service(null, { service_tier: 'Gold', service_tier_source: 'manual' });
  const block = { serviceLine: 'pest', outcome: 'treated', includedWithWaveGuard: false };

  test('gate dark: every key and the fence are exactly what they were, the card still counts', async () => {
    delete process.env.GATE_RESERVICE_ASKS;
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    expect(await reserviceReportPdfSignature(member, { knex: null })).toBe('-rs2nt-rcd1');
    expect(reserviceReportRenderedSignature({ reserviceReport: block, reserviceReportCard: { version: 1 } }, member)).toBe('-rs2nt-rcd1');
    expect(reserviceAsksPdfPart(member)).toBe('');
    expect(reserviceAsksFenceStamp()).toBe('');
    delete process.env.GATE_RESERVICE_REPORT_CARD;
    expect(await reserviceCardRenderFence(member, null)).toBe('off');
  });

  test('gate on with something to show: lookup and store agree, and the block takes the card\'s place', async () => {
    on();
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    expect(await reserviceReportPdfSignature(member, { knex: null })).toBe('-rs2nt-ras1');
    expect(reserviceReportRenderedSignature({ reserviceReport: block, reserviceAsksReport: { version: 1 } }, member)).toBe('-rs2nt-ras1');
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    expect(await reserviceReportPdfSignature(member, { knex: null })).toBe('-rs2nt-ras1p');
    expect(reserviceReportRenderedSignature({ reserviceReport: block, reserviceAsksReport: { version: 1 } }, member)).toBe('-rs2nt-ras1p');
  });

  test('gate on but this record has no freeze: the card keys are untouched', async () => {
    on();
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    expect(await reserviceReportPdfSignature(plain, { knex: null })).toBe('-rs2nt-rcd1');
    expect(reserviceReportRenderedSignature({ reserviceReport: block, reserviceReportCard: { version: 1 } }, plain)).toBe('-rs2nt-rcd1');
  });

  test('gate on, an inspection-only record: no asks part, the card keys stay, lookup and store agree', async () => {
    on();
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    const inspected = service(asks, { service_tier: 'Gold', service_tier_source: 'manual', visit_outcome: 'inspection_only' });
    const lookup = await reserviceReportPdfSignature(inspected, { knex: null });
    expect(lookup).toBe('-rs2ni-rcd1');
    expect(reserviceReportRenderedSignature({
      reserviceReport: { ...block, outcome: 'inspection_only' }, reserviceReportCard: { version: 1 },
    }, inspected)).toBe(lookup);
  });

  test('copy gate off: the asks part stands alone on both sides', async () => {
    on();
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    expect(await reserviceReportPdfSignature(member, { knex: null })).toBe('-ras1');
    expect(reserviceReportRenderedSignature({ reserviceAsksReport: { version: 1 } }, member)).toBe('-ras1');
    expect(reserviceReportRenderedSignature({}, member)).toBe('');
  });

  test('a gate flip changes the fence without a deploy', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    delete process.env.GATE_RESERVICE_ASKS;
    const before = await reserviceCardRenderFence(member, null);
    on();
    const after = await reserviceCardRenderFence(member, null);
    expect(after).not.toBe(before);
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    expect(await reserviceCardRenderFence(member, null)).not.toBe(after);
  });
});

// Minimal fixture knex — same shape as reservice-report-card-payload.test.js.
function makeKnex(fixtures = {}) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const q = {};
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (arguments.length === 2) rows = rows.filter((r) => r[a] === b);
        return q;
      },
      andWhere() { return q; },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot() { return q; },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      whereRaw() { return q; },
      orderBy() { return q; },
      first() { return Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

describe('payload through buildReportV1Data', () => {
  const asks = frozen(
    [
      item({ id: 'a' }),
      item({ id: 'b', text: 'Why did the tech come so late?', kind: 'question' }),
      item({ id: 'c', source: 'call', quoted: false, lead: 'On your call, you mentioned', text: 'spiders on the porch.', pests: ['Spiders'] }),
    ],
    { a: { answer: 'treated', productIds: ['prod-1'] }, b: { answer: 'noted' }, c: { answer: 'not_today' } },
    { officeNotes: { c: OFFICE_REASON } },
  );
  const record = () => ({
    id: 'svc-asks-1',
    scheduled_service_id: 'ss-asks-1',
    customer_id: 'cust-asks',
    service_line: 'pest',
    service_type: 'Pest Control Re-Service',
    service_date: '2026-11-01',
    is_callback: true,
    first_name: 'Dana',
    last_name: 'Q.',
    areas_serviced: JSON.stringify(['Inside', 'Outside']),
    structured_notes: JSON.stringify({}),
    service_data: JSON.stringify({
      reserviceRequest: { version: 1, text: 'Ants are back in the kitchen.', source: 'picker', pests: ['ants'] },
      reserviceAsks: asks,
    }),
  });
  const fixtures = () => ({
    service_products: [
      { id: 'p1', service_record_id: 'svc-asks-1', product_id: 'prod-1', product_name: 'Test Product', application_method: 'perimeter_spray', targets: JSON.stringify(['Ants']), created_at: '2026-11-01' },
    ],
  });
  function gates() {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
  }

  test('gate off: today\'s card, no new key, and the payload is the same as before', async () => {
    gates();
    delete process.env.GATE_RESERVICE_ASKS;
    const data = await buildReportV1Data(record(), 'tok-asks-off', makeKnex(fixtures()));
    expect('reserviceAsksReport' in data).toBe(false);
    expect(data.reserviceReportCard).toBeTruthy();
    expect(data.reserviceReportCard.youToldUs.text).toBe('Ants are back in the kitchen.');
  });

  test('gate on: the block replaces the card; the office-only line and the office reason never reach the payload', async () => {
    gates();
    on();
    const data = await buildReportV1Data(record(), 'tok-asks-on', makeKnex(fixtures()));
    expect('reserviceReportCard' in data).toBe(false);
    const block = data.reserviceAsksReport;
    expect(block).toMatchObject({ version: 1, title: 'Your re-service', lane: 'pest' });
    // "come so late" is a schedule complaint: not shown. Two items remain.
    expect(block.summary).toBe('You told us about 2 things. Here is what we did for each.');
    expect(block.told).toHaveLength(2);
    expect(block.did.map((row) => row.chip)).toEqual(['Treated', 'Follow-up']);
    expect(block.did[0].line).toBe('We treated it with Test Product.');
    expect(block.products).toEqual([{ name: 'Test Product', where: null, how: null }]);
    expect(block.expectation).toBe(data.reserviceReport.expectation);
    expect(block.stillSeeing).toBe('ants');
    const json = JSON.stringify(data);
    expect(json).not.toContain('missed window');
    expect(json).not.toContain('come so late');
    // The hero and every other key are unchanged by the block.
    const rest = { ...data };
    delete rest.reserviceAsksReport;
    delete process.env.GATE_RESERVICE_ASKS;
    const off = await buildReportV1Data(record(), 'tok-asks-on', makeKnex(fixtures()));
    delete off.reserviceReportCard;
    expect(JSON.parse(JSON.stringify(rest))).toEqual(JSON.parse(JSON.stringify(off)));
  });

  test('gate on, record without a freeze: today\'s card stays', async () => {
    gates();
    on();
    const svc = record();
    svc.service_data = JSON.stringify({ reserviceRequest: { version: 1, text: 'Ants are back.', source: 'picker', pests: [] } });
    const data = await buildReportV1Data(svc, 'tok-asks-nofreeze', makeKnex(fixtures()));
    expect('reserviceAsksReport' in data).toBe(false);
    expect(data.reserviceReportCard).toBeTruthy();
  });
});
