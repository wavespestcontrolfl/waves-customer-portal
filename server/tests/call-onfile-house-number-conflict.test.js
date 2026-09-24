// House-number disagreement lane (live incident, 2026-09-16): a call validated
// 1250 Example Street at premise level while the profile carried a
// web-form 1260 that does not exist. The never-overwrite rule kept the
// profile (correctly), the correction lane heard no correction language, and
// the routing gate saw a validated address — so nothing surfaced it. These
// pin the pure detector, the card's review lane, and the auto-resolve rule
// that closes the card once the record carries the stated number.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const { onFileHouseNumberConflict, sameHouseNumberStreet } = require('../services/call-triage-flags');
const { buildTriageItem } = require('../services/call-routing-gates');
const { classifyTriageItem, RULE_NOTES, visitAtStatedAddress } = require('../services/triage-auto-resolve');

const av = (street, extra = {}) => ({
  status: 'validated_accept',
  normalized: { street_line_1: street, city: 'Parrish', state: 'FL', postal_code: '34219', ...extra },
});
const ON_FILE = { address_line1: '1260 Example Street', address_line2: null, city: 'Parrish', zip: '34219' };

describe('onFileHouseNumberConflict — fractional numbers', () => {
  test('12 1/2 is one house token: it conflicts with 12 and stays on the same street as 13', () => {
    const onFile12 = { ...ON_FILE, address_line1: '12 Example Street' };
    expect(onFileHouseNumberConflict({ addressValidation: av('12 1/2 Example Street'), onFileAddress: onFile12 })).toMatchObject({ stated_house_number: '12 1/2', on_file_house_number: '12' });
    const onFile13 = { ...ON_FILE, address_line1: '13 Example Street' };
    expect(onFileHouseNumberConflict({ addressValidation: av('12 1/2 Example Street'), onFileAddress: onFile13 })).toMatchObject({ stated_house_number: '12 1/2', on_file_house_number: '13' });
    expect(sameHouseNumberStreet('12 1/2 Example Street', '12 1/2 Example St')).toBe(true);
  });
});

describe('onFileHouseNumberConflict', () => {
  test('same street, different house number → the two streets and numbers', () => {
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 Example Street'), onFileAddress: ON_FILE })).toEqual({
      stated_street: '1250 Example Street',
      on_file_street: '1260 Example Street',
      stated_house_number: '1250',
      on_file_house_number: '1260',
      stated_city: 'Parrish',
      stated_zip: '34219',
    });
  });

  test('a corrected verdict counts the same as an accepted one', () => {
    const r = onFileHouseNumberConflict({ addressValidation: { ...av('1250 Example Street'), status: 'corrected' }, onFileAddress: ON_FILE });
    expect(r?.stated_house_number).toBe('1250');
  });

  test('suffix spelling and case do not hide the same street', () => {
    const r = onFileHouseNumberConflict({ addressValidation: av('1250 EXAMPLE ST'), onFileAddress: ON_FILE });
    expect(r?.on_file_house_number).toBe('1260');
  });

  test('a unit on either side is not part of the comparison', () => {
    const r = onFileHouseNumberConflict({
      addressValidation: av('500 Main St Apt 4'),
      onFileAddress: { address_line1: '510 Main St', address_line2: 'Apt 4', city: 'Parrish', zip: '34219' },
    });
    expect(r?.stated_house_number).toBe('500');
  });

  test('numbered streets keep their number: 42 St and 43 St are different streets', () => {
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 42 St'), onFileAddress: { ...ON_FILE, address_line1: '1260 43 St' } })).toBeNull();
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 42nd St'), onFileAddress: { ...ON_FILE, address_line1: '1260 42nd Street' } })?.stated_house_number).toBe('1250');
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 42 St'), onFileAddress: { ...ON_FILE, address_line1: '1260 42 St' } })?.on_file_house_number).toBe('1260');
  });

  test('a suffix ahead of a post-directional still equates the suffixless spelling', () => {
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 Main St N'), onFileAddress: { ...ON_FILE, address_line1: '1260 Main N' } })?.stated_house_number).toBe('1250');
    expect(sameHouseNumberStreet('1250 Main St N', '1250 Main N')).toBe(true);
    expect(sameHouseNumberStreet('1250 Main St N', '1250 Main St S')).toBe(false);
    expect(sameHouseNumberStreet('Apt 4, 1250 Main St', '1250 Main St')).toBe(true);
    expect(sameHouseNumberStreet('Apt 4, 1260 Main St', 'Apt 4, 1250 Main St')).toBe(false);
  });

  test('a legacy unit-first on-file line is peeled before comparing', () => {
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 Main St'), onFileAddress: { ...ON_FILE, address_line1: 'Apt 4, 1260 Main St' } })?.on_file_house_number).toBe('1260');
  });

  test('same house number → nothing to confirm', () => {
    expect(onFileHouseNumberConflict({ addressValidation: av('1260 Example Street'), onFileAddress: ON_FILE })).toBeNull();
  });

  test('a different street is a second property, not a typo', () => {
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 Sample Avenue'), onFileAddress: ON_FILE })).toBeNull();
  });

  test('a different ZIP or city is not a typo either', () => {
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 Example Street', { postal_code: '34221' }), onFileAddress: ON_FILE })).toBeNull();
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 Example Street', { city: 'Bradenton' }), onFileAddress: ON_FILE })).toBeNull();
  });

  test('a locality missing on one side does not veto the comparison', () => {
    const r = onFileHouseNumberConflict({
      addressValidation: av('1250 Example Street', { city: null, postal_code: null }),
      onFileAddress: { address_line1: '1260 Example Street', city: null, zip: null },
    });
    expect(r?.stated_house_number).toBe('1250');
  });

  test('only a positively validated premise may contradict the record', () => {
    for (const status of ['confirm_needed', 'missing_component', 'ambiguous', 'out_of_service_area', 'api_unavailable', 'not_attempted']) {
      expect(onFileHouseNumberConflict({ addressValidation: { ...av('1250 Example Street'), status }, onFileAddress: ON_FILE })).toBeNull();
    }
    expect(onFileHouseNumberConflict({ addressValidation: null, onFileAddress: ON_FILE })).toBeNull();
  });

  test('a street with no house number on either side cannot disagree by number', () => {
    expect(onFileHouseNumberConflict({ addressValidation: av('Example Street'), onFileAddress: ON_FILE })).toBeNull();
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 Example Street'), onFileAddress: { ...ON_FILE, address_line1: 'Example Street' } })).toBeNull();
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 Example Street'), onFileAddress: null })).toBeNull();
    expect(onFileHouseNumberConflict({ addressValidation: av('1250 Example Street'), onFileAddress: { address_line1: '' } })).toBeNull();
  });
});

describe('on_file_house_number_conflict card', () => {
  test('files in the address-review lane, advisory, with both streets in the payload', () => {
    const conflict = onFileHouseNumberConflict({ addressValidation: av('1250 Example Street'), onFileAddress: ON_FILE });
    const item = buildTriageItem({
      callLogId: 42,
      flag: 'on_file_house_number_conflict',
      extraction: { meta: { call_summary: 'quote' }, scheduling: { status: 'none' } },
      severity: 'advisory',
      addressValidation: av('1250 Example Street'),
      onFileAddress: ON_FILE,
      extraPayload: conflict,
    });
    expect(item.category).toBe('address_review');
    expect(item.severity).toBe('advisory');
    const payload = JSON.parse(item.payload);
    // The card carries the scheduling ask a held confirmed booking must
    // answer before the sweep may close it, and joins the evidence set.
    expect(payload.scheduling_window).toEqual(expect.objectContaining({ status: 'none' }));
    expect(require('../services/triage-auto-resolve').EVIDENCE_CODES.has('on_file_house_number_conflict')).toBe(true);
    expect(payload).toMatchObject({
      stated_street: '1250 Example Street',
      on_file_street: '1260 Example Street',
      stated_house_number: '1250',
      on_file_house_number: '1260',
      on_file_address: { address_line1: '1260 Example Street', city: 'Parrish', zip: '34219' },
    });
  });
});

describe('triage auto-resolve: house_number_adopted', () => {
  const NOW = new Date('2026-09-23T12:00:00Z');
  const item = (over = {}) => ({
    id: 1, status: 'open', severity: 'advisory', reason_code: 'on_file_house_number_conflict',
    created_at: '2026-09-16T15:00:00Z', customer_deleted_at: null,
    call_extraction: { scheduling: { status: 'none' } },
    customer_address_line1: '1260 Example Street', customer_zip: '34219',
    customer_city: 'Parrish',
    payload: { stated_house_number: '1250', on_file_house_number: '1260', stated_street: '1250 Example Street', stated_city: 'Parrish', stated_zip: '34219', scheduling_status: null },
    ...over,
  });

  test('resolves once the record carries the stated house number', () => {
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Example Street' }), {}, { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'house_number_adopted' });
    expect(RULE_NOTES.house_number_adopted).toMatch(/house number the caller stated/);
  });

  test('stands while the record still carries the other number, and is never aged out', () => {
    expect(classifyTriageItem(item(), {}, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ created_at: '2026-01-01T00:00:00Z' }), {}, { now: NOW })).toBeNull();
  });

  test('a confirmed call held on this card stays open until a booking lands', () => {
    const confirmed = item({
      customer_address_line1: '1250 Example Street',
      call_extraction: { scheduling: { status: 'confirmed' } },
      payload: { stated_house_number: '1250', stated_street: '1250 Example Street', stated_city: 'Parrish', stated_zip: '34219', scheduling_status: 'confirmed' },
    });
    expect(classifyTriageItem(confirmed, {}, { now: NOW })).toBeNull();
    expect(classifyTriageItem(confirmed, { evidence: new Map([[1, { booking_after_card: true }]]) }, { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'house_number_adopted' });
  });

  test('a stated unit must be on the record before the ask is settled', () => {
    const unitCard = item({
      customer_address_line1: '1250 Example Street', customer_address_line2: 'Apt 3',
      payload: { stated_house_number: '1250', stated_street: '1250 Example Street', stated_unit: 'Apt 2', stated_city: 'Parrish', stated_zip: '34219', scheduling_status: null },
    });
    expect(classifyTriageItem(unitCard, {}, { now: NOW })).toBeNull();
    expect(classifyTriageItem({ ...unitCard, customer_address_line2: null }, {}, { now: NOW })).toBeNull();
    expect(classifyTriageItem({ ...unitCard, customer_address_line2: 'Unit 2' }, {}, { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'house_number_adopted' });
  });

  test('an unrelated street sharing the house number does not settle the ask', () => {
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Unrelated Avenue' }), {}, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Example Street', customer_zip: '34221' }), {}, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Example Street', customer_city: 'Bradenton', customer_zip: null }), {}, { now: NOW })).toBeNull();
    // A stated ZIP the record no longer carries is not the same premise.
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Example Street', customer_zip: null }), {}, { now: NOW })).toBeNull();
  });

  test('directional and suffix spellings resolve exactly as they were detected', () => {
    expect(sameHouseNumberStreet('1250 North Main Street', '1250 N Main St')).toBe(true);
    expect(sameHouseNumberStreet('Main St', '1250 Main St')).toBe(false);
    expect(classifyTriageItem(item({
      customer_address_line1: '1250 N Main St', customer_city: 'Parrish', customer_zip: '34219',
      payload: { stated_house_number: '1250', stated_street: '1250 North Main Street', stated_city: 'Parrish', stated_zip: '34219', scheduling_status: null },
    }), {}, { now: NOW })).toEqual({ action: 'resolve', rule: 'house_number_adopted' });
  });

  test('a saved spelling without a suffix still settles the ask (the detector equates them)', () => {
    expect(sameHouseNumberStreet('1250 Main St', '1250 Main')).toBe(true);
    expect(sameHouseNumberStreet('1250 Main St', '1250 Main Ave')).toBe(false);
    expect(sameHouseNumberStreet('1250 N Main St', '1250 North Main Street')).toBe(true);
    expect(sameHouseNumberStreet('Main St', '1250 Main St')).toBe(false);
    expect(classifyTriageItem(item({
      customer_address_line1: '1250 Main', customer_city: 'Parrish', customer_zip: '34219',
      payload: { stated_house_number: '1250', stated_street: '1250 Main St', stated_city: 'Parrish', stated_zip: '34219', scheduling_status: null },
    }), {}, { now: NOW })).toEqual({ action: 'resolve', rule: 'house_number_adopted' });
  });

  test('suffix spelling and a unit do not keep a settled ask open', () => {
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Example St Apt 2' }), {}, { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'house_number_adopted' });
    // A card whose call stated no locality is settled by the street alone.
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Example Street', customer_zip: null, customer_city: null,
      payload: { stated_house_number: '1250', stated_street: '1250 Example Street', scheduling_status: null } }), {}, { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'house_number_adopted' });
  });

  test('a deleted customer or a card with no stated number is left alone', () => {
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Example Street', customer_deleted_at: '2026-09-20T00:00:00Z' }), {}, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Example Street', payload: {} }), {}, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ customer_address_line1: '1250 Example Street', payload: { stated_house_number: '1250' } }), {}, { now: NOW })).toBeNull();
  });
});

describe('visitAtStatedAddress', () => {
  const card = {
    call_customer_id: 'c1',
    payload: { stated_street: '1250 Example St', stated_city: 'Parrish', stated_zip: '34219', stated_house_number: '1250' },
  };
  const visit = (line1, city = 'Parrish', zip = '34219', line2 = null) => ({
    customer_id: 'c1', service_address_line1: line1, service_address_line2: line2, service_address_city: city, service_address_zip: zip,
  });

  test('a booking at the stated premise counts; one at the old on-file number does not', () => {
    expect(visitAtStatedAddress(card, visit('1250 Example Street'), new Map())).toBe(true);
    // Equivalent spellings (directional, suffixless) via the detector's comparator.
    expect(visitAtStatedAddress({ ...card, payload: { ...card.payload, stated_street: '1250 North Example St' } }, visit('1250 N Example Street'), new Map())).toBe(true);
    expect(visitAtStatedAddress(card, visit('1250 Example'), new Map())).toBe(true);
    expect(visitAtStatedAddress(card, visit('1260 Example St'), new Map())).toBe(false);
    expect(visitAtStatedAddress(card, visit('1250 Example St', 'Bradenton'), new Map())).toBe(false);
    expect(visitAtStatedAddress(card, visit('1250 Example St', 'Parrish', '34221'), new Map())).toBe(false);
  });

  test('a stated unit must match; a card with no stated street proves nothing', () => {
    const unitCard = { ...card, payload: { ...card.payload, stated_unit: 'Apt 2' } };
    expect(visitAtStatedAddress(unitCard, visit('1250 Example St', 'Parrish', '34219', 'Apt 2'), new Map())).toBe(true);
    expect(visitAtStatedAddress(unitCard, visit('1250 Example St', 'Parrish', '34219', 'Apt 3'), new Map())).toBe(false);
    expect(visitAtStatedAddress({ ...card, payload: {} }, visit('1250 Example St'), new Map())).toBe(false);
  });
});

describe('heldConflictTaskDecision (verdict route)', () => {
  const { __private } = require('../routes/admin-triage');
  const { heldConflictTaskDecision } = __private;
  const held = {
    scheduling_window: { status: 'confirmed', confirmed_start_at: '2026-09-25T14:00:00Z', requested_address: { street_line_1: '1250 Example St', city: 'Parrish', postal_code: '34219' } },
    on_file_address: { address_line1: '1260 Example St', address_line2: null, city: 'Parrish', zip: '34219' },
    stated_street: '1250 Example St',
  };

  test('Accept on a confirmed, unbooked call files the task, judged at the approved on-file address', () => {
    const d = heldConflictTaskDecision({ verdict: 'accept', wrongFields: [], heldConflictPayload: held, bookingCovered: false });
    expect(d.file).toBe(true);
    expect(d.skippedReason).toBe('address_confirmed_on_file_after_house_number_dispute');
    expect(d.approvedWindow.requested_address).toEqual({ street_line_1: '1260 Example St', street_line_2: null, city: 'Parrish', postal_code: '34219', raw_text: null });
    const multi = heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: { ...held, scheduling_window: { ...held.scheduling_window, requested_address: { ...held.scheduling_window.requested_address, additional_properties: [{ street_line_1: '9 Other Rd' }] } } } });
    expect(multi.approvedWindow.requested_address.additional_properties).toEqual([{ street_line_1: '9 Other Rd' }]);
    expect(multi.approvedWindow.requested_address.street_line_1).toBe('1260 Example St');
    const spoken = heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: { ...held, scheduling_window: { ...held.scheduling_window, requested_address: { ...held.scheduling_window.requested_address, raw_text: '1250 Example Street in Parrish' } } } });
    expect(spoken.approvedWindow.requested_address.raw_text).toBeNull();
    expect(d.approvedPayload.stated_street).toBeUndefined();
    expect(d.approvedPayload.heard_address.street_line_1).toBe('1260 Example St');
  });

  test('the live customer address outranks the card snapshot once the office adopted the caller\'s number', () => {
    const d = heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: held, liveOnFile: { address_line1: '1250 Example St', address_line2: null, city: 'Parrish', zip: '34219' } });
    expect(d.approvedWindow.requested_address.street_line_1).toBe('1250 Example St');
    expect(d.approvedPayload.on_file_address.address_line1).toBe('1250 Example St');
    expect(heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: held, liveOnFile: { address_line1: '' } }).approvedWindow.requested_address.street_line_1).toBe('1260 Example St');
  });

  test('a live address that is neither reviewed premise does not retarget the ask', () => {
    const moved = heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: held, liveOnFile: { address_line1: '9 Other Road', address_line2: null, city: 'Parrish', zip: '34219' } });
    expect(moved.approvedWindow.requested_address.street_line_1).toBe('1260 Example St');
    expect(moved.approvedPayload.on_file_address.address_line1).toBe('1260 Example St');
    // Same street line but a different unit or town is not a reviewed premise either.
    const otherUnit = heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: held, liveOnFile: { address_line1: '1260 Example Street', address_line2: 'Apt 2', city: 'Parrish', zip: '34219' } });
    expect(otherUnit.approvedWindow.requested_address.street_line_2).toBeNull();
    const otherTown = heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: held, liveOnFile: { address_line1: '1260 Example Street', address_line2: null, city: 'Elsewhere', zip: '34220' } });
    expect(otherTown.approvedWindow.requested_address.city).toBe('Parrish');
    const retyped = heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: held, liveOnFile: { address_line1: '1260 Example Street', address_line2: null, city: 'Parrish', zip: '34219' } });
    expect(retyped.approvedWindow.requested_address.street_line_1).toBe('1260 Example Street');
  });

  test('an unconfirmed card still files the reassignment task for a held booking', () => {
    const unconfirmed = { ...held, scheduling_window: { status: 'none' } };
    expect(heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: unconfirmed }).file).toBe(false);
    expect(heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: unconfirmed }).file).toBe(false);
  });


  test('a covering booking, or a card whose call never confirmed, files nothing', () => {
    expect(heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: held, bookingCovered: true }).file).toBe(false);
    expect(heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: { ...held, scheduling_window: { status: 'none' } } }).file).toBe(false);
    expect(heldConflictTaskDecision({ verdict: 'accept', heldConflictPayload: null }).file).toBe(false);
  });

  test('Deny keeps the appointment owed unless the scheduling extraction itself was denied', () => {
    expect(heldConflictTaskDecision({ verdict: 'deny', wrongFields: ['address'], heldConflictPayload: held }).file).toBe(true);
    expect(heldConflictTaskDecision({ verdict: 'deny', wrongFields: ['address'], heldConflictPayload: held }).skippedReason).toBe('house_number_dispute_denied_appointment_unbooked');
    expect(heldConflictTaskDecision({ verdict: 'deny', wrongFields: ['scheduling'], heldConflictPayload: held }).file).toBe(false);
    expect(heldConflictTaskDecision({ verdict: 'deny', wrongFields: ['service'], heldConflictPayload: held }).file).toBe(false);
  });
});

describe('disputeReuseDecision (reused AI booking under a dispute)', () => {
  const { disputeReuseDecision } = require('../services/call-recording-processor');
  test('a dispute holds NEW side effects and never pulls an existing assignment', () => {
    expect(disputeReuseDecision({ disputed: false })).toEqual({ holdNewSideEffects: false });
    expect(disputeReuseDecision({ disputed: true })).toEqual({ holdNewSideEffects: true });
    expect(Object.keys(disputeReuseDecision({ disputed: true }))).toEqual(['holdNewSideEffects']);
  });
});
