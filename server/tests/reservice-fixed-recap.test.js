// Fast Complete's ONE fixed customer text for a pest re-service
// (GATE_FAST_COMPLETE_RECAP; scope decision 5): built on the server from the
// saved facts, never AI, never signed, exactly one text.
const fs = require('fs');
const path = require('path');
const {
  MODE, TEMPLATE_KEY, SAFETY_LINE, buildReserviceFixedRecap, reserviceFixedRecapHonored,
  loadReserviceFixedRecapFacts, customerTextOutcome,
} = require('../services/reservice-fixed-recap');

const LINK = 'https://example.test/r/abc';
const SPRAY = { application_method: 'spot_treatment' };
const build = (over = {}) => buildReserviceFixedRecap({
  address: '1234 Oak Bend Dr',
  areas: ['Inside'],
  products: [{ ...SPRAY, targets: ['Ants'] }],
  reportUrl: LINK,
  ...over,
});

describe('buildReserviceFixedRecap', () => {
  test.each([
    [['Inside'], 'inside'],
    [['Outside'], 'outside'],
    [['Inside', 'Outside'], 'inside and outside'],
    [['Outside', 'Inside'], 'inside and outside'],
    [['Garage'], 'the garage'],
    [['Inside', 'Garage'], 'inside and the garage'],
    [['Inside', 'Outside', 'Garage'], 'inside, outside and the garage'],
  ])('where %j reads "%s"', (areas, phrase) => {
    expect(build({ areas })).toBe(
      `Your re-service at 1234 Oak Bend Dr is done. We treated ${phrase} for ants. ${SAFETY_LINE} Details: ${LINK}`,
    );
  });

  test.each([
    [['Ants'], 'ants'],
    [['Ants', 'Roaches'], 'ants and roaches'],
    [['Ants', 'Roaches', 'Spiders'], 'ants, roaches and spiders'],
  ])('pests %j read "%s"', (targets, phrase) => {
    expect(build({ areas: ['Inside', 'Outside'], products: [{ ...SPRAY, targets }] })).toBe(
      `Your re-service at 1234 Oak Bend Dr is done. We treated inside and outside for ${phrase}. ${SAFETY_LINE} Details: ${LINK}`,
    );
  });

  test('the same pests on every product row are listed once', () => {
    const products = [{ ...SPRAY, targets: ['Ants', 'Roaches'] }, { ...SPRAY, targets: ['ants', 'Roaches'] }, { application_method: 'spot_treatment', targets: ['Ants'] }];
    expect(build({ products })).toContain('for ants and roaches.');
  });

  test('the scope example', () => {
    expect(build({ areas: ['Inside', 'Outside'] })).toBe(
      'Your re-service at 1234 Oak Bend Dr is done. We treated inside and outside for ants. Keep kids and pets off treated areas until dry. Details: https://example.test/r/abc',
    );
  });

  describe('the kids-and-pets line needs a recorded liquid application', () => {
    test.each([['bait_placement'], ['granular_broadcast'], ['station_check']])('%s only: no safety line', (application_method) => {
      const text = build({ products: [{ application_method, targets: ['Roaches'] }] });
      expect(text).not.toContain('Keep kids and pets');
      expect(text).toBe(`Your re-service at 1234 Oak Bend Dr is done. We treated inside for roaches. Details: ${LINK}`);
    });

    test.each([['spot_treatment'], ['perimeter_spray'], ['broadcast_spray']])('%s: safety line', (application_method) => {
      expect(build({ products: [{ application_method, targets: ['Ants'] }] })).toContain(SAFETY_LINE);
    });

    test('one spray row among bait rows is enough', () => {
      const products = [{ application_method: 'bait_placement', targets: ['Ants'] }, { application_method: 'perimeter_spray', targets: ['Ants'] }];
      expect(build({ products })).toContain(SAFETY_LINE);
    });

    test('no product rows: no safety line', () => {
      expect(build({ products: [] })).not.toContain('Keep kids and pets');
    });
  });

  describe('a clause with no fact behind it is dropped whole', () => {
    test('no pests', () => {
      expect(build({ products: [{ ...SPRAY, targets: [] }] })).toBe(
        `Your re-service at 1234 Oak Bend Dr is done. We treated inside. ${SAFETY_LINE} Details: ${LINK}`,
      );
    });

    test('no pests and no where: the address line, the safety line if applicable, the link', () => {
      expect(build({ areas: [], products: [{ ...SPRAY, targets: [] }] })).toBe(
        `Your re-service at 1234 Oak Bend Dr is done. ${SAFETY_LINE} Details: ${LINK}`,
      );
      expect(build({ areas: [], products: [] })).toBe(`Your re-service at 1234 Oak Bend Dr is done. Details: ${LINK}`);
    });

    test('no where', () => {
      expect(build({ areas: [] })).toBe(`Your re-service at 1234 Oak Bend Dr is done. We treated for ants. ${SAFETY_LINE} Details: ${LINK}`);
    });

    test('a legacy area label has no phrase and is left out', () => {
      expect(build({ areas: ['Lanai'] })).toBe(`Your re-service at 1234 Oak Bend Dr is done. We treated for ants. ${SAFETY_LINE} Details: ${LINK}`);
    });

    test('no address', () => {
      expect(build({ address: '' })).toBe(`Your re-service is done. We treated inside for ants. ${SAFETY_LINE} Details: ${LINK}`);
    });

    test('no report link: no text at all', () => {
      expect(build({ reportUrl: '' })).toBe('');
    });
  });

  test('a typed pest name that is too long, symbolic or banned is dropped, not cleaned up', () => {
    const products = [{ ...SPRAY, targets: ['Ants', 'x'.repeat(60), 'call 555-1212 now!', '<b>hi</b>'] }];
    expect(build({ products })).toContain('We treated inside for ants.');
  });

  test('an other-pest name the tech typed reads naturally', () => {
    expect(build({ products: [{ ...SPRAY, targets: ['Ants', 'Palmetto bugs'] }] })).toContain('for ants and palmetto bugs.');
  });

  test('never signed, never a review ask, one link, no AI', () => {
    for (const text of [build(), build({ areas: [], products: [] }), build({ products: [{ application_method: 'bait_placement', targets: ['Ants'] }] })]) {
      expect(text).not.toMatch(/-\s*Waves\s*$/i);
      expect(text).not.toMatch(/waves/i);
      expect(text).not.toMatch(/review/i);
      expect(text.match(/https?:\/\//g)).toHaveLength(1);
      expect(text.trim().endsWith(LINK)).toBe(true);
      expect(text).not.toMatch(/\n/);
    }
  });
});

describe('reserviceFixedRecapHonored', () => {
  const on = { requestedMode: MODE, fastCompleteGate: true, recapGate: true, serviceKey: 'pest_re_service' };
  test('honored only with the mode, both gates and a pest re-service', () => {
    expect(reserviceFixedRecapHonored(on)).toBe(true);
    expect(reserviceFixedRecapHonored({ ...on, requestedMode: undefined })).toBe(false);
    expect(reserviceFixedRecapHonored({ ...on, requestedMode: 'other' })).toBe(false);
    expect(reserviceFixedRecapHonored({ ...on, fastCompleteGate: false })).toBe(false);
    expect(reserviceFixedRecapHonored({ ...on, recapGate: false })).toBe(false);
    expect(reserviceFixedRecapHonored({ ...on, serviceKey: 'general_pest_control' })).toBe(false);
    expect(reserviceFixedRecapHonored({ ...on, serviceKey: 'lawn_re_service' })).toBe(false);
    expect(reserviceFixedRecapHonored({ ...on, recapGate: 'true' })).toBe(false);
  });
});

describe('customerTextOutcome (what the tech sees after Complete)', () => {
  test('sent: the exact body', () => {
    expect(customerTextOutcome({ honored: true, status: 'sent', body: 'X' })).toEqual({ sent: true, body: 'X', reason: null });
  });
  test('deferred by the send window: queued, with its body', () => {
    expect(customerTextOutcome({ honored: true, status: 'deferred', body: 'X' })).toMatchObject({ sent: false, queued: true, body: 'X' });
  });
  test.each([
    ['no_phone', 'no phone number on file'],
    ['blocked', "the customer can't be texted (opted out or blocked)"],
    ['failed', 'the text could not be sent'],
    ['suppressed_delivery_mode', 'texts are off for this visit type'],
    ['skipped_recap_sms_already_sent', 'a recap text already went out for this visit'],
    ['not_sent', 'nothing was sent'],
  ])('%s: no text, with a reason', (status, reason) => {
    expect(customerTextOutcome({ honored: true, status, body: 'X' })).toMatchObject({ sent: false, body: null, reason });
  });
  test('mode not honored (a gate off): no text, gate reason, never a body', () => {
    expect(customerTextOutcome({ honored: false, status: 'not_requested', body: 'X' })).toEqual({
      sent: false, body: null, reason: 'the customer text is turned off for this visit',
    });
  });
});

describe('loadReserviceFixedRecapFacts', () => {
  const fakeDb = (tables) => (name) => {
    const rows = tables[name];
    const chain = {
      where: () => chain,
      first: async () => (Array.isArray(rows) ? rows[0] : rows),
      select: async () => rows,
    };
    return chain;
  };

  test('reads the saved address, areas and product rows', async () => {
    const db = fakeDb({
      customers: { address_line1: '9 Home St', city: 'Parrish' },
      service_records: { areas_serviced: '["Inside","Garage"]' },
      service_products: [{ application_method: 'perimeter_spray', targets: ['Ants'] }, { application_method: 'bait_placement', targets: '["Roaches"]' }],
    });
    const facts = await loadReserviceFixedRecapFacts(db, { svc: { customer_id: 1 }, recordId: 7, reportUrl: LINK });
    expect(facts).toEqual({
      address: '9 Home St',
      areas: ['Inside', 'Garage'],
      products: [{ application_method: 'perimeter_spray', targets: ['Ants'] }, { application_method: 'bait_placement', targets: ['Roaches'] }],
      reportUrl: LINK,
    });
  });

  test('a stamped visit address outranks the customer address', async () => {
    const db = fakeDb({ customers: { address_line1: '9 Home St' }, service_records: { areas_serviced: [] }, service_products: [] });
    const facts = await loadReserviceFixedRecapFacts(db, { svc: { customer_id: 1, service_address_line1: '77 Rental Ave', service_address_city: 'Venice' }, recordId: 7, reportUrl: LINK });
    expect(facts.address).toBe('77 Rental Ave');
  });
});

// complete-scheduled-service.js needs a live DB to import, so its wiring is
// pinned by source, the way its sibling suites pin structure.
describe('complete-scheduled-service wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');

  test('the mode is honored from the live profile and both gates; an unhonored request sends no completion text', () => {
    expect(src).toContain('customerRecapMode,');
    expect(src).toContain('sendCompletionSms: sendCompletionSmsRequested,');
    expect(src).toMatch(/reserviceFixedRecapHonored\(\{\s*requestedMode: customerRecapMode,\s*fastCompleteGate: [^\n]*isEnabled\('reserviceFastComplete'\),\s*recapGate: [^\n]*isEnabled\('fastCompleteRecap'\),\s*serviceKey: completionProfile\?\.serviceKey,/);
    expect(src).toMatch(/const sendCompletionSms = reserviceFixedRecapRequested && !reserviceFixedRecap\s*\? false\s*: sendCompletionSmsRequested;/);
  });

  test('the fixed text replaces the whole template chain: one text', () => {
    const fixed = src.indexOf('if (reserviceFixedBody) {');
    const report = src.indexOf('} else if (completionUsesReportLane({');
    expect(fixed).toBeGreaterThan(0);
    expect(report).toBeGreaterThan(fixed);
    const block = src.slice(fixed, report);
    expect(block).toContain("sentSmsType = 'service_complete'");
    expect(block).toContain('sentSmsBody = reserviceFixedBody');
    // Not the AI recap, the sign-off helper, or a review suffix.
    expect(block).not.toMatch(/smsRecap|reviewSuffix|renderTemplate/);
    // The builder itself never signs.
    expect(fs.readFileSync(path.join(__dirname, '..', 'services', 'reservice-fixed-recap.js'), 'utf8')).not.toMatch(/smsRecap|completion-recap/);
  });

  test('goes through the existing send path, keyed to this text\'s template', () => {
    expect(src).toContain('if (reserviceFixedBody) smsMetadata.templateKey = ReserviceFixedRecap.TEMPLATE_KEY;');
    expect(TEMPLATE_KEY).toBe('reservice_fixed_recap');
    // The single send call site is unchanged: consent/STOP/opt-out live behind it.
    expect((src.match(/await sendCustomerMessage\(sendInput\)/g) || []).length).toBe(1);
  });

  test('no review ask rides or follows it', () => {
    expect(src).toMatch(/&& !suppressTypedCustomerComms\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*&& !reserviceFixedRecap;/);
  });

  test('the response carries the text outcome only when the sheet asked', () => {
    expect(src).toMatch(/\.\.\.\(reserviceFixedRecapRequested \? \{\s*customerText: ReserviceFixedRecap\.customerTextOutcome\(/);
  });

  test('the sent body is stored where the office reads it', () => {
    expect(src).toContain('completionSmsBody: sentSmsBody,');
    expect(src).toContain('completionSmsRecapMode: ReserviceFixedRecap.MODE');
  });
});
