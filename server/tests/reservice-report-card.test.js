/**
 * Re-service report card (GATE_RESERVICE_REPORT_CARD): "You told us" from
 * the words FROZEN at completion, the "What we did" summary, the still-seeing
 * topic, and the PDF cache-key component. Customer names here are synthetic.
 */
const {
  buildReserviceReportCard,
  freezeReserviceRequest,
  readFrozenReserviceRequest,
  reserviceReportCardGateOn,
  CALL_LEAD,
  OFFICE_LEAD,
  MAX_REQUEST_CHARS,
} = require('../services/service-report/reservice-report-card');
const {
  reserviceReportPdfSignature,
  reserviceReportRenderedSignature,
} = require('../services/service-report/reservice-report');
const { SAFETY_LINE } = require('../services/reservice-fixed-recap');
const { scrubCustomerText } = require('../services/completion-comms-context');

const ENV_KEYS = ['GATE_RESERVICE_REPORT_CARD', 'GATE_RESERVICE_REPORT_COPY'];
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

const treatedBlock = { serviceLine: 'pest', outcome: 'treated' };
const sprayRow = { application_method: 'perimeter_spray', targets: ['Ants', 'Spiders'] };

function frozenService(frozen, extra = {}) {
  return {
    id: 'rec-1',
    is_callback: true,
    service_data: JSON.stringify({ reserviceRequest: frozen }),
    areas_serviced: ['Inside', 'Outside'],
    client_pest_rating: 2,
    client_pest_rating_source: 'technician',
    client_pest_rating_defaulted: false,
    ...extra,
  };
}

function card(service, args = {}) {
  process.env.GATE_RESERVICE_REPORT_CARD = 'true';
  return buildReserviceReportCard(service, {
    block: treatedBlock,
    products: [sprayRow],
    scrub: scrubCustomerText,
    ...args,
  });
}

describe('gate', () => {
  test('exact "true" only, read at call time', () => {
    delete process.env.GATE_RESERVICE_REPORT_CARD;
    expect(reserviceReportCardGateOn()).toBe(false);
    for (const v of ['1', 'TRUE', 'on', '']) {
      process.env.GATE_RESERVICE_REPORT_CARD = v;
      expect(reserviceReportCardGateOn()).toBe(false);
    }
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    expect(reserviceReportCardGateOn()).toBe(true);
  });

  test('gate off: null even with a block and frozen words', () => {
    delete process.env.GATE_RESERVICE_REPORT_CARD;
    const svc = frozenService({ version: 1, text: 'Ants in the kitchen.', source: 'picker', pests: ['ants'] });
    expect(buildReserviceReportCard(svc, { block: treatedBlock, products: [sprayRow], scrub: scrubCustomerText })).toBeNull();
  });

  test('gate on but no reserviceReport block: null (the card hangs off the block)', () => {
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    expect(buildReserviceReportCard(frozenService(null), { block: null, products: [sprayRow], scrub: scrubCustomerText })).toBeNull();
  });
});

describe('You told us: phrasing and quote rule per source', () => {
  test('picker words are quoted (verbatim)', () => {
    const out = card(frozenService({ version: 1, text: 'Ants are back in the kitchen.', source: 'picker', pests: [] }));
    expect(out.youToldUs).toEqual({
      source: 'picker', quoted: true, lead: null, text: 'Ants are back in the kitchen.', pests: [],
    });
  });

  test('text words are quoted (verbatim)', () => {
    const out = card(frozenService({ version: 1, text: 'Roaches again by the sink.', source: 'text', pests: [] }));
    expect(out.youToldUs).toMatchObject({ source: 'text', quoted: true, lead: null, text: 'Roaches again by the sink.' });
  });

  test('call paraphrase is NOT quoted and reads "On your call, you mentioned"', () => {
    const out = card(frozenService({ version: 1, text: 'Ants in the kitchen near the sink', source: 'call', pests: [] }));
    expect(out.youToldUs).toEqual({
      source: 'call', quoted: false, lead: CALL_LEAD, text: 'ants in the kitchen near the sink.', pests: [],
    });
    expect(out.youToldUs.text).not.toMatch(/["“”]/);
  });

  test('call keeps "I" and shouted words capitalized', () => {
    const out = card(frozenService({ version: 1, text: 'I keep seeing ants in the garage.', source: 'call', pests: [] }));
    expect(out.youToldUs.text).toBe('I keep seeing ants in the garage.');
  });

  test('office entry is NOT quoted and reads as reported to the office', () => {
    const out = card(frozenService({ version: 1, text: 'Spiders around the lanai.', source: 'office', pests: [] }));
    expect(out.youToldUs).toEqual({
      source: 'office', quoted: false, lead: OFFICE_LEAD, text: 'Spiders around the lanai.', pests: [],
    });
  });

  test('an unknown or missing source cannot pick a quote rule: no words shown', () => {
    expect(card(frozenService({ version: 1, text: 'Ants in the kitchen.', source: 'fax', pests: [] })).youToldUs).toBeNull();
    expect(card(frozenService({ version: 1, text: 'Ants in the kitchen.', source: null, pests: [] })).youToldUs).toBeNull();
    // ...but the pests the customer picked still show.
    const withPests = card(frozenService({ version: 1, text: 'Ants in the kitchen.', source: null, pests: ['ants'] }));
    expect(withPests.youToldUs).toEqual({ source: null, quoted: false, lead: null, text: null, pests: ['Ants'] });
  });

  test('pest chips use the picker labels for the lane, in canonical order', () => {
    const pest = card(frozenService({ version: 1, text: null, source: null, pests: ['spiders', 'ants', 'other', 'bogus'] }));
    expect(pest.youToldUs.pests).toEqual(['Ants', 'Spiders', 'Something else']);
    const lawn = card(frozenService({ version: 1, text: null, source: null, pests: ['weeds', 'brown_patches'] }), {
      block: { serviceLine: 'lawn', outcome: 'treated' },
    });
    expect(lawn.youToldUs.pests).toEqual(['Weeds', 'Brown or dead patches']);
  });
});

describe('You told us: hidden / scrubbed / capped', () => {
  test('nothing on file hides the section', () => {
    expect(card(frozenService(null)).youToldUs).toBeNull();
    expect(card({ id: 'r', is_callback: true, service_data: null }).youToldUs).toBeNull();
    expect(card(frozenService({ version: 1, text: '   ', source: 'picker', pests: [] })).youToldUs).toBeNull();
  });

  test('typed text passes the customer-words scrub: access details and codes never render', () => {
    const out = card(frozenService({
      version: 1, text: 'The gate code is 4821. Ants are in the kitchen again. Call me after 5.', source: 'picker', pests: [],
    }));
    expect(out.youToldUs.text).toBe('Ants are in the kitchen again.');
    expect(JSON.stringify(out)).not.toContain('4821');
    expect(JSON.stringify(out)).not.toMatch(/gate code/i);
  });

  test('credential-shaped tokens inside a pest sentence are masked', () => {
    const out = card(frozenService({ version: 1, text: 'Ants near unit B12 and the kitchen.', source: 'text', pests: [] }));
    expect(out.youToldUs.text).toContain('[redacted]');
    expect(out.youToldUs.text).not.toContain('B12');
  });

  test('words that scrub to nothing hide the words (and the section when no pests either)', () => {
    const words = { version: 1, text: 'Please call me tomorrow, thanks.', source: 'picker', pests: [] };
    expect(card(frozenService(words)).youToldUs).toBeNull();
    const withPests = card(frozenService({ ...words, pests: ['ants'] }));
    expect(withPests.youToldUs).toEqual({ source: 'picker', quoted: false, lead: null, text: null, pests: ['Ants'] });
  });

  test('no scrub available: the words are left out, never shown raw', () => {
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    const out = buildReserviceReportCard(
      frozenService({ version: 1, text: 'Ants in the kitchen.', source: 'picker', pests: ['ants'] }),
      { block: treatedBlock, products: [sprayRow], scrub: null },
    );
    expect(out.youToldUs.text).toBeNull();
    expect(JSON.stringify(out)).not.toContain('Ants in the kitchen');
  });

  test('a throwing scrub fails closed', () => {
    const out = card(
      frozenService({ version: 1, text: 'Ants in the kitchen.', source: 'picker', pests: [] }),
      { scrub: () => { throw new Error('boom'); } },
    );
    expect(out.youToldUs).toBeNull();
  });

  test('our own timing/safety claims in the words are dropped', () => {
    const out = card(frozenService({
      version: 1, text: 'Ants in the kitchen. It is safe to re-enter at 4 PM.', source: 'call', pests: [],
    }), { scrub: (t) => t });
    expect(out.youToldUs).toBeNull();
  });

  test('long words are capped at a word boundary with an ellipsis', () => {
    const long = `${'Ants on the counter. '.repeat(30)}`.trim();
    const out = card(frozenService({ version: 1, text: long, source: 'picker', pests: [] }));
    expect(out.youToldUs.text.length).toBeLessThanOrEqual(MAX_REQUEST_CHARS + 1);
    expect(out.youToldUs.text.endsWith('…')).toBe(true);
  });
});

describe('frozen at completion, never read live', () => {
  test('freezeReserviceRequest keeps text/source/pests for a callback only', () => {
    const frozen = freezeReserviceRequest({
      is_callback: true,
      customer_request: '  Ants   in the kitchen ',
      customer_request_source: 'picker',
      customer_request_pests: ['ants'],
    });
    expect(frozen).toEqual({ version: 1, text: 'Ants in the kitchen', source: 'picker', pests: ['ants'] });
    expect(freezeReserviceRequest({ is_callback: false, customer_request: 'x', customer_request_source: 'picker' })).toBeNull();
    expect(freezeReserviceRequest({ is_callback: true, customer_request: null, customer_request_pests: null })).toBeNull();
    expect(freezeReserviceRequest({ is_callback: true, customer_request: '', customer_request_pests: '[]' })).toBeNull();
    expect(freezeReserviceRequest(null)).toBeNull();
  });

  test('pests stored as a JSON string are read; an invalid source drops the words', () => {
    expect(freezeReserviceRequest({
      is_callback: true, customer_request: 'Ants', customer_request_source: 'picker', customer_request_pests: '["ants","roaches"]',
    }).pests).toEqual(['ants', 'roaches']);
    expect(freezeReserviceRequest({
      is_callback: true, customer_request: 'Ants', customer_request_source: 'smoke-signal', customer_request_pests: [],
    })).toEqual({ version: 1, text: 'Ants', source: null, pests: [] });
  });

  test('the card reads service_data, not a live scheduled_services field', () => {
    // A live edit after completion cannot reach the card: the builder is
    // handed only the record, and ignores any customer_request on it.
    const svc = frozenService(
      { version: 1, text: 'Ants in the kitchen.', source: 'picker', pests: [] },
      { customer_request: 'EDITED LATER: wasps', customer_request_source: 'office', customer_request_pests: ['wasps'] },
    );
    const out = card(svc);
    expect(out.youToldUs.text).toBe('Ants in the kitchen.');
    expect(JSON.stringify(out)).not.toContain('EDITED');
  });

  test('a record with no frozen request (pre-freeze) shows no "You told us"', () => {
    const out = card({ id: 'old', is_callback: true, service_data: {}, customer_request: 'Ants', customer_request_source: 'picker' });
    expect(out.youToldUs).toBeNull();
  });

  test('readFrozenReserviceRequest tolerates objects, strings and junk', () => {
    const frozen = { version: 1, text: 'a', source: 'picker', pests: [] };
    expect(readFrozenReserviceRequest({ service_data: { reserviceRequest: frozen } })).toEqual(frozen);
    expect(readFrozenReserviceRequest({ service_data: JSON.stringify({ reserviceRequest: frozen }) })).toEqual(frozen);
    expect(readFrozenReserviceRequest({ service_data: '{bad' })).toBeNull();
    expect(readFrozenReserviceRequest({ service_data: { reserviceRequest: 'x' } })).toBeNull();
    expect(readFrozenReserviceRequest({})).toBeNull();
  });
});

describe('What we did', () => {
  test('performed: pests from product targets, where from areas, found from the tech tap, safety with a wet application', () => {
    const out = card(frozenService(null), {
      products: [sprayRow, { application_method: 'bait_placement', targets: ['ants'] }],
    });
    expect(out.whatWeDid).toEqual({
      pests: ['ants', 'spiders'],
      where: 'inside and outside',
      found: { rating: 2, label: expect.any(String) },
      safetyLine: SAFETY_LINE,
    });
    expect(out.whatWeDid.found.label).toMatch(/^[A-Z]/);
  });

  test('targets stored as a JSON string on the row are read', () => {
    const out = card(frozenService(null), { products: [{ application_method: 'perimeter_spray', targets: '["roaches"]' }] });
    expect(out.whatWeDid.pests).toEqual(['roaches']);
  });

  test('no safety line without a recorded wet application (bait / granular / no rows)', () => {
    const bait = card(frozenService(null), { products: [{ application_method: 'bait_placement', targets: ['ants'] }] });
    expect(bait.whatWeDid.safetyLine).toBeNull();
    const granular = card(frozenService(null), { products: [{ application_method: 'granular_broadcast', targets: ['ants'] }] });
    expect(granular.whatWeDid.safetyLine).toBeNull();
    const none = card(frozenService(null), { products: [] });
    expect(none.whatWeDid.safetyLine).toBeNull();
    expect(none.whatWeDid.pests).toEqual([]);
    // Rating + areas still make a truthful summary.
    expect(none.whatWeDid.where).toBe('inside and outside');
  });

  test('an untouched first-visit default or a customer rating is not "what we found"', () => {
    expect(card(frozenService(null, { client_pest_rating_defaulted: true })).whatWeDid.found).toBeNull();
    expect(card(frozenService(null, { client_pest_rating_source: 'customer' })).whatWeDid.found).toBeNull();
    expect(card(frozenService(null, { client_pest_rating: null })).whatWeDid.found).toBeNull();
    expect(card(frozenService(null, { client_pest_rating: 9 })).whatWeDid.found).toBeNull();
  });

  test('an explicit zero rating is still a finding ("none")', () => {
    const out = card(frozenService(null, { client_pest_rating: 0 }));
    expect(out.whatWeDid.found.rating).toBe(0);
  });

  test('uses the active label set when given', () => {
    const labels = [
      { key: 'a', name: 'Clear', min: 0, max: 0.4 },
      { key: 'b', name: 'Mild', min: 0.5, max: 2.4 },
      { key: 'c', name: 'Busy', min: 2.5, max: 5 },
    ];
    const out = card(frozenService(null, { client_pest_rating: 2 }), { pestPressureLabels: labels });
    expect(out.whatWeDid.found.label).toBe('Mild');
  });

  test('lawn re-service: no activity tap, where without inside/outside phrases is dropped', () => {
    const out = card(
      frozenService(null, { areas_serviced: ['Front Lawn'] }),
      { block: { serviceLine: 'lawn', outcome: 'treated' }, products: [{ application_method: 'liquid_spray', targets: ['dollarweed'] }] },
    );
    expect(out.whatWeDid).toMatchObject({ pests: ['dollarweed'], where: null, found: null, safetyLine: SAFETY_LINE });
  });

  test('nothing recorded: no "What we did" section at all', () => {
    const out = card(frozenService(null, { areas_serviced: [], client_pest_rating: null }), { products: [] });
    expect(out.whatWeDid).toBeNull();
  });

  test.each(['inspection_only', 'customer_declined', 'incomplete'])('%s never shows "What we did", but "You told us" still can', (outcome) => {
    const out = card(
      frozenService({ version: 1, text: 'Ants in the kitchen.', source: 'picker', pests: ['ants'] }),
      { block: { serviceLine: 'pest', outcome } },
    );
    expect(out.whatWeDid).toBeNull();
    expect(out.youToldUs).toMatchObject({ quoted: true, text: 'Ants in the kitchen.' });
  });
});

describe('still-seeing topic', () => {
  test('one pest, two pests, many, none', () => {
    const topic = (products, frozen) => card(frozenService(frozen), { products }).stillSeeing;
    expect(topic([{ application_method: 'perimeter_spray', targets: ['ants'] }], null)).toBe('ants');
    expect(topic([sprayRow], null)).toBe('ants or spiders');
    expect(topic([{ application_method: 'perimeter_spray', targets: ['ants', 'spiders', 'roaches'] }], null)).toBe('activity');
    expect(topic([], null)).toBe('activity');
  });

  test('falls back to the pests the customer picked (not "Something else")', () => {
    const picked = { version: 1, text: null, source: null, pests: ['roaches'] };
    expect(card(frozenService(picked), { products: [] }).stillSeeing).toBe('roaches');
    expect(card(frozenService({ ...picked, pests: ['other'] }), { products: [] }).stillSeeing).toBe('activity');
  });

  test('lawn reads "problem areas"', () => {
    expect(card(frozenService(null), { block: { serviceLine: 'lawn', outcome: 'treated' } }).stillSeeing).toBe('problem areas');
  });
});

describe('payload shape', () => {
  test('carries exactly version / youToldUs / whatWeDid / stillSeeing and never a URL or token', () => {
    const out = card(frozenService({ version: 1, text: 'Ants in the kitchen.', source: 'picker', pests: ['ants'] }));
    expect(Object.keys(out).sort()).toEqual(['stillSeeing', 'version', 'whatWeDid', 'youToldUs']);
    expect(JSON.stringify(out)).not.toMatch(/token|https?:|reservice\//i);
  });

  test('returned (with empty sections) whenever the gate is on and the block exists', () => {
    const out = card(frozenService(null, { areas_serviced: [], client_pest_rating: null }), { products: [] });
    expect(out).toMatchObject({ version: 1, youToldUs: null, whatWeDid: null });
  });
});

describe('PDF cache key component', () => {
  const member = {
    id: 'rec-1', customer_id: 'cust-1', scheduled_service_id: null, is_callback: true, service_tier: 'Gold', service_tier_source: 'manual', service_type: 'Pest Control Re-Service',
  };
  const block = { serviceLine: 'pest', outcome: 'treated', includedWithWaveGuard: false };

  test('card gate dark: the keys are exactly what they were', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    delete process.env.GATE_RESERVICE_REPORT_CARD;
    expect(await reserviceReportPdfSignature(member, { knex: null })).toBe('-rs2nt');
    expect(reserviceReportRenderedSignature({ reserviceReport: block, reserviceReportCard: { version: 1 } }, member)).toBe('-rs2nt');
  });

  test('card gate on: lookup and store agree on -rcd1', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    expect(await reserviceReportPdfSignature(member, { knex: null })).toBe('-rs2nt-rcd1');
    expect(reserviceReportRenderedSignature({ reserviceReport: block, reserviceReportCard: { version: 1 } }, member)).toBe('-rs2nt-rcd1');
  });

  test('store side keys off the card the render actually carried', () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    expect(reserviceReportRenderedSignature({ reserviceReport: block }, member)).toBe('-rs2nt');
  });

  test('card on without the copy gate: no block, no key', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    expect(await reserviceReportPdfSignature(member, { knex: null })).toBe('');
    expect(reserviceReportRenderedSignature({ reserviceReport: block, reserviceReportCard: { version: 1 } }, member)).toBe('');
  });
});

describe('completion wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

  test('the request freezes onto service_data from the LOCKED row, ungated, inside the completion transaction', () => {
    const call = src.indexOf(".freezeReserviceRequest(lockedSvcRow || svc)");
    expect(call).toBeGreaterThan(-1);
    // After the locked row is read and the serviceData literal exists...
    expect(src.lastIndexOf("const lockedSvcRow = await trx('scheduled_services')", call)).toBeGreaterThan(-1);
    expect(src.lastIndexOf('const serviceData = {', call)).toBeGreaterThan(-1);
    // ...before the record insert persists service_data.
    expect(src.indexOf('recordInsert.service_data = serializeJsonb(serviceData)', call)).toBeGreaterThan(call);
    // The freeze is not conditioned on the card gate (a flip must not strand
    // visits completed while it was dark).
    const window = src.slice(call - 900, call + 400).replace(/\/\/.*$/gm, '');
    expect(window).not.toMatch(/GATE_RESERVICE_REPORT_CARD|reserviceReportCardGateOn|isEnabled\('reserviceReportCard'\)/);
    expect(window).toContain('serviceData.reserviceRequest = frozenReserviceRequest');
  });
});

describe('feature-gate registration', () => {
  test('registry key reserviceReportCard, catalogued as a plain on/off GATE_RESERVICE_REPORT_CARD', () => {
    const { gates, knownGateCatalog } = require('../config/feature-gates');
    expect(Object.prototype.hasOwnProperty.call(gates, 'reserviceReportCard')).toBe(true);
    expect(gates.reserviceReportCard).toBe(process.env.GATE_RESERVICE_REPORT_CARD === 'true');
    const entry = knownGateCatalog().get('GATE_RESERVICE_REPORT_CARD');
    expect(entry).toBeTruthy();
    expect(entry.kind).toBe('boolean');
    expect(entry.description).toMatch(/You told us/);
  });
});

describe('paraphrases written about the customer are left out (production phrasing 2026-10-01)', () => {
  const frozen = (source, text, pests = []) => ({ version: 1, source, text, pests });
  const youToldUs = (f) => card(frozenService(f), { scrub: (t) => t })?.youToldUs ?? null;
  test.each([
    ['call', 'Fire ants biting her feet and getting into her bed.'],
    ['call', 'The caller suspects they have a rodent issue.'],
    ['call', 'Needs a WDO inspection before Friday.'],
    ['office', 'Customer reports roaches in the kitchen.'],
  ])('%s: %p shows no words', (source, text) => {
    expect(youToldUs(frozen(source, text))).toBeNull();
    expect(youToldUs(frozen(source, text, ['ants']))).toMatchObject({ text: null, pests: ['Ants'] });
  });
  test('a fragment in the customer\'s own frame still reads under the lead', () => {
    expect(youToldUs(frozen('call', 'Spiders on the front porch and pool cage.'))).toMatchObject({ lead: 'On your call, you mentioned', text: 'spiders on the front porch and pool cage.' });
  });
  test('verbatim picker / text words are never screened', () => {
    expect(youToldUs(frozen('picker', 'My husband saw roaches by her crib'))).toMatchObject({ quoted: true, text: 'My husband saw roaches by her crib' });
  });
});
