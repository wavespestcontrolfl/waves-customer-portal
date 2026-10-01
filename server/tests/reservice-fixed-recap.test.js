// Fast Complete's ONE fixed customer text for a pest re-service
// (GATE_FAST_COMPLETE_RECAP; scope decision 5): built on the server from the
// saved facts, never AI, never signed, exactly one text.
const fs = require('fs');
const path = require('path');
const {
  MODE, TEMPLATE_KEY, SAFETY_LINE, buildReserviceFixedRecap, isWetMethod, providerBody, reserviceFixedRecapHonored,
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
      'Your re-service at 1234 Oak Bend Dr is done. We treated inside and outside for ants. Keep kids and pets off treated areas until dry; your technician confirms the timing. Details: https://example.test/r/abc',
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
    expect(customerTextOutcome({ honored: true, status: 'sent', body: 'X' })).toEqual({ sent: true, channel: 'sms', body: 'X', reason: null });
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
    expect(block).toContain('sentSmsBody = ReserviceFixedRecap.providerBody(reserviceFixedBody)');
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

describe('review fixes (#5363 r1)', () => {
  test('a stored sent text is reported even when the retry is no longer honored (gate flipped mid-resume)', () => {
    expect(customerTextOutcome({ honored: false, status: 'sent', body: 'X' })).toEqual({ sent: true, channel: 'sms', body: 'X', reason: null });
    expect(customerTextOutcome({ honored: false, status: 'deferred', body: 'X' })).toMatchObject({ queued: true, body: 'X' });
    expect(customerTextOutcome({ honored: false, status: undefined })).toMatchObject({ sent: false, reason: 'the customer text is turned off for this visit' });
  });
  test('the quiet-hours replay row records the fixed template key', () => {
    const source = require('fs').readFileSync(require.resolve('../services/complete-scheduled-service'), 'utf8');
    const at = source.indexOf("entry_point: 'dispatch_completion_deferred'");
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 800)).toContain('template_key: ReserviceFixedRecap.TEMPLATE_KEY');
  });
});

describe('review fixes (#5363 r1, second set)', () => {
  const { lintComms } = require('../services/comms-lint');
  const { reentrySafetyClaimFinding } = require('../services/content/content-guardrails');
  const ActivityIndicators = require('../services/service-report/activity-indicators');

  test('the safety line is the approved conditional idiom', () => {
    expect(SAFETY_LINE).toBe('Keep kids and pets off treated areas until dry; your technician confirms the timing.');
  });

  test('the full built text passes the compliance gate, the banned-copy screen and the SMS lint as the provider gets it', () => {
    const cases = [
      build({ areas: ['Inside', 'Outside'] }),
      build({ areas: ['Garage'], products: [{ application_method: 'soil_drench', targets: ['Ants', 'Roaches', 'Spiders'] }] }),
      build({ areas: [], products: [] }),
    ];
    for (const raw of cases) {
      expect(reentrySafetyClaimFinding(raw)).toBeNull();
      expect(ActivityIndicators.findBannedCustomerCopy(raw)).toEqual([]);
      const sent = providerBody(raw);
      expect(lintComms(sent, { channel: 'sms', audience: 'customer' })).toMatchObject({ pass: true, failures: [] });
    }
  });

  describe('wet methods come from the canonical spray classifier', () => {
    test.each([['soil_drench'], ['spot_treatment'], ['perimeter_spray'], ['broadcast_spray'], ['foliar_spray'], ['fog_ulv'], ['pin_stream'], ['Soil Drench']])('%s is wet', (m) => {
      expect(isWetMethod(m)).toBe(true);
      expect(build({ products: [{ application_method: m, targets: ['Ants'] }] })).toContain(SAFETY_LINE);
    });
    test.each([['bait_placement'], ['station_check'], ['trunk_injection'], ['granular_broadcast'], [''], [null], [undefined]])('%s is dry', (m) => {
      expect(isWetMethod(m)).toBe(false);
      expect(build({ products: [{ application_method: m, targets: ['Ants'] }] })).not.toContain('Keep kids');
    });
  });

  test('the provider-normalized body drops the https scheme and normalizes typography', () => {
    const raw = build({ address: '12 O\u2019Neil Dr', reportUrl: 'https://portal.example.test/report/abc' });
    const sent = providerBody(raw);
    expect(sent).toContain('Details: portal.example.test/report/abc');
    expect(sent).not.toContain('https://');
    expect(sent).toContain("12 O'Neil Dr");
    expect(providerBody(sent)).toBe(sent);
  });

  test('the sent body shown to the tech is the provider body, and the outcome carries the recorded channel', () => {
    expect(customerTextOutcome({ honored: true, status: 'sent', body: 'X', channel: 'push' })).toMatchObject({ sent: true, channel: 'push' });
    expect(customerTextOutcome({ honored: true, status: 'sent', body: 'X', channel: 'mms' })).toMatchObject({ channel: 'sms' });
    expect(customerTextOutcome({ honored: true, status: 'deferred', body: 'X' })).toMatchObject({ queued: true, channel: 'sms' });
    const src = require('fs').readFileSync(require.resolve('../services/complete-scheduled-service'), 'utf8');
    expect(src).toContain('channel: finalRecordNotes.sentSmsChannel || null,');
  });

  describe('the address is the frozen completion snapshot when there is one', () => {
    const fakeDb = (tables) => (name) => {
      const rows = tables[name];
      const chain = { where: () => chain, first: async () => (Array.isArray(rows) ? rows[0] : rows), select: async () => rows };
      return chain;
    };
    const tables = (service_data) => ({
      customers: { address_line1: '9 New Home St' },
      service_records: { areas_serviced: [], service_data },
      service_products: [],
    });

    test('snapshot street wins over a moved customer address and a re-stamped visit', async () => {
      const service_data = JSON.stringify({ reportIdentitySnapshot: { version: 1, address: { line1: '1 Frozen Ct', city: 'Parrish' } } });
      const facts = await loadReserviceFixedRecapFacts(fakeDb(tables(service_data)), { svc: { customer_id: 1, service_address_line1: '77 Restamped Ave' }, recordId: 7, reportUrl: LINK });
      expect(facts.address).toBe('1 Frozen Ct');
    });

    test('a snapshot with no street gives no street, never the current one', async () => {
      const service_data = { reportIdentitySnapshot: { version: 1, address: { line1: null } } };
      const facts = await loadReserviceFixedRecapFacts(fakeDb(tables(service_data)), { svc: { customer_id: 1 }, recordId: 7, reportUrl: LINK });
      expect(facts.address).toBeNull();
    });

    test('no snapshot falls back to the current rows', async () => {
      const facts = await loadReserviceFixedRecapFacts(fakeDb(tables(null)), { svc: { customer_id: 1 }, recordId: 7, reportUrl: LINK });
      expect(facts.address).toBe('9 New Home St');
    });
  });
});

describe('review fixes (#5363 r2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');

  test('the stored and shown body is the one the provider was handed (link wrap included)', () => {
    const at = src.indexOf('completionSmsProviderAccepted = smsResult.sent === true;');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 900);
    expect(block).toMatch(/if \(reserviceFixedBody && smsResult\.sent === true\s*&& typeof smsResult\.sentBody === 'string' && smsResult\.sentBody\) \{/);
    expect(block).toContain('smsNotesDelta.completionSmsBody = sentSmsBody;');
    expect(block).toContain('completionSmsAcceptedSnapshot.body = sentSmsBody;');
  });

  test('no video recap is queued behind the fixed text', () => {
    expect(src).toMatch(/process\.env\.PEST_RECAP === 'true'[^\n]*record\.scheduled_service_id && !reserviceFixedRecap\) \{/);
    const delivery = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'recap-delivery.js'), 'utf8');
    expect(delivery).toContain("reason: 'reservice_fixed_text'");
    expect(MODE).toBe('reservice_fixed');
  });
});

describe('review fixes (#5363 r3)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');

  test('the record is created with the fixed-text marker (no window without it)', () => {
    expect(src).toMatch(/const structuredNotes = \{\s*\n[^\n]*propertyServiceArea[^\n]*\n(?:\s*\/\/[^\n]*\n)+\s*\.\.\.\(reserviceFixedRecap \? \{ completionSmsRecapMode: ReserviceFixedRecap\.MODE \} : \{\}\),/);
  });

  test('a facts read failure leaves the closeout open for retry instead of finalizing', () => {
    const at = src.indexOf('reserviceFixedFacts = await ReserviceFixedRecap.loadReserviceFixedRecapFacts(db, {');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 900)).toContain('return exitForCompletionSmsResume(factsErr);');
  });

  test('an accepted send whose audit threw still stores the provider-handed body', () => {
    expect(src).toContain('fixedRecap: !!reserviceFixedBody,');
    expect(src).toContain("if (snap.fixedRecap && typeof e.sentBody === 'string' && e.sentBody) snap.body = e.sentBody;");
    expect(src).toContain('...(snap.fixedRecap && snap.body ? { completionSmsBody: snap.body } : {}),');
  });
});

describe('review fixes (#5363 pre-push r3)', () => {
  test('an unknown provider outcome reads as unconfirmed, never as not sent', () => {
    const out = customerTextOutcome({ honored: true, status: 'failed', body: 'X', deliveryUnverified: true });
    expect(out).toMatchObject({ sent: false, unverified: true, body: 'X' });
    expect(out.reason).toMatch(/may have gone out/);
    expect(customerTextOutcome({ honored: true, status: 'failed', body: 'X' })).toMatchObject({ sent: false, body: null, reason: 'the text could not be sent' });
  });
  test('the response passes the uncertainty marker', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    expect(src).toContain('deliveryUnverified: !!finalRecordNotes.completionSmsDeliveryUnverifiedAt,');
  });
});

describe('review fixes (#5363 r4)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
  const { countSegments } = require('../services/messaging/segment-counter');
  const longLink = `https://portal.wavespestcontrol.com/report/${'a1b2c3d4'.repeat(4)}`;

  test('six pests, three areas, a long address and an unshortened link still fit two segments', () => {
    const body = buildReserviceFixedRecap({
      address: '12345 North Tamiami Trail Unit 1204',
      areas: ['Inside', 'Outside', 'Garage'],
      products: [{ ...SPRAY, targets: ['Ants', 'Roaches', 'Spiders', 'Silverfish', 'Earwigs', 'Crickets'] }],
      reportUrl: longLink,
    });
    expect(countSegments(providerBody(body)).segmentCount).toBeLessThanOrEqual(2);
    expect(body).toContain(SAFETY_LINE);
    expect(body).toContain(`Details: ${longLink}`);
    expect(body).toMatch(/We treated inside, outside and the garage for ants/);
  });

  test('a link too long for any pest still keeps the where, then sheds it', () => {
    const body = buildReserviceFixedRecap({
      address: '12345 North Tamiami Trail Unit 1204', areas: ['Inside'],
      products: [{ ...SPRAY, targets: ['Ants'] }], reportUrl: `https://portal.wavespestcontrol.com/report/${'a'.repeat(150)}`,
    });
    expect(countSegments(providerBody(body)).segmentCount).toBeLessThanOrEqual(2);
    expect(body).toContain(SAFETY_LINE);
  });

  test('a short text keeps every pest', () => {
    expect(build({ products: [{ ...SPRAY, targets: ['Ants', 'Roaches', 'Spiders'] }] })).toContain('for ants, roaches and spiders.');
  });

  test('the link is shortened before the send so the stored body is final', () => {
    const at = src.indexOf('const fixedReportLink = reportSmsUrl && reportSmsUrl !== reportUrl');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toContain("codePrefix: 'report'");
  });

  test('the fixed text needs a real report token on any template version', () => {
    const { completionSmsWithheldForMissingReportToken } = require('../services/complete-scheduled-service');
    expect(completionSmsWithheldForMissingReportToken({ serviceReportV1Delivery: false, typedDeliveryMode: 'auto_send', reportToken: null, reserviceFixedRecap: true })).toBe(true);
    expect(completionSmsWithheldForMissingReportToken({ serviceReportV1Delivery: false, typedDeliveryMode: 'auto_send', reportToken: null })).toBe(false);
    expect(src).toContain('completionSmsWithheldForMissingReportToken({ serviceReportV1Delivery, typedDeliveryMode, reportToken, reserviceFixedRecap })');
  });

  test('an accepted push whose audit threw keeps the push channel', () => {
    expect(src).toContain("if (e.providerOutcome?.provider === 'push') snap.channel = 'push';");
  });

  test('the legacy pest recap never texts a record frozen with the fixed-text marker', () => {
    const recap = fs.readFileSync(path.join(__dirname, '..', 'services', 'pest-recap.js'), 'utf8');
    expect(recap).toMatch(/const alreadyTexted = !!existing\?\.recap_sms_sent_at \|\| completionSmsAlreadySent \|\| fixedReserviceText;/);
    expect(recap).toContain("existingNotes.completionSmsRecapMode === require('./reservice-fixed-recap').MODE");
  });
});
