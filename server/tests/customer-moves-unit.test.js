/**
 * Customer moving flow (GATE_MOVING_FLOW): the pure rules in
 * services/customer-moves.js and services/move-address-verdict.js, with no
 * database. The live-Postgres behavior is in moving-flow-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: jest.fn(async () => ({ id: 'n1' })) };
});

const Moves = require('../services/customer-moves');
const { cancelMoveAddressVerdict, moveVerdictLabel } = require('../services/move-address-verdict');
const { STATUSES } = require('../services/address-validation');

const P = Moves._private;
const NOW = new Date('2026-11-02T15:00:00Z');

describe('dates', () => {
  test('blank is "not known yet"', () => {
    expect(P.cleanDate('', 'move-out date', NOW)).toBeNull();
    expect(P.cleanDate(null, 'move-out date', NOW)).toBeNull();
  });

  test('a real ISO date inside the window passes', () => {
    expect(P.cleanDate('2026-11-17', 'move-out date', NOW)).toBe('2026-11-17');
  });

  test('a malformed or impossible date is refused with a plain message', () => {
    expect(() => P.cleanDate('11/17/2026', 'move-out date', NOW)).toThrow('Enter the move-out date as a date.');
    expect(() => P.cleanDate('2026-02-30', 'move-in date', NOW)).toThrow('Enter the move-in date as a date.');
  });

  test('more than 60 days back or 400 days ahead is refused', () => {
    expect(() => P.cleanDate('2026-08-01', 'move-out date', NOW)).toThrow('too far away');
    expect(() => P.cleanDate('2028-01-15', 'move-out date', NOW)).toThrow('too far away');
    expect(P.cleanDate('2026-09-04', 'move-out date', NOW)).toBe('2026-09-04');
  });

  test('prettyDate reads an ISO date with no time-zone hop', () => {
    expect(P.prettyDate('2026-11-01')).toBe('Nov 1, 2026');
    expect(P.prettyDate('nope')).toBeNull();
  });
});

describe('typed address', () => {
  test('too short or too long is refused', () => {
    expect(() => P.cleanTyped('12')).toThrow('Enter the full address');
    expect(() => P.cleanTyped('x'.repeat(201))).toThrow('Enter the full address');
  });

  test('spaces are collapsed', () => {
    expect(P.cleanTyped('  12   Example  Way ')).toBe('12 Example Way');
  });

  test('a typed unit is kept when Google drops it', () => {
    expect(P.typedUnit('12 Example Way Apt 4B, Parrish FL')).toBe('Apt 4B');
    expect(P.typedUnit('12 Example Way #12, Parrish')).toBe('#12');
    expect(P.typedUnit('12 Example Way, Parrish')).toBeNull();
    const normalized = P.normalizedFrom({
      normalized: { street_line_1: '12 Example Way', city: 'Parrish', state: 'FL', postal_code: '34219' },
    }, '12 Example Way Unit 3, Parrish');
    expect(normalized).toEqual({ line1: '12 Example Way', line2: 'Unit 3', city: 'Parrish', state: 'FL', zip: '34219' });
  });
});

describe('the 24 hour reuse of a paid check', () => {
  const result = { typed: '12 Example Way', normalized: {}, verdict: 'in_area' };
  const move = (over) => ({ last_check: JSON.stringify({ id: 'abcdef0123456789', key: '12 example way', checked_at: '2026-11-02T10:00:00.000Z', providerAnswered: true, result, ...over }) });

  test('the same text within 24 hours is reused, with its check id', () => {
    expect(P.reusableCheck(move(), '12 example way', NOW)).toMatchObject({ id: 'abcdef0123456789', result });
  });

  test('other text, an old answer, a provider failure or a check with no id is asked again', () => {
    expect(P.reusableCheck(move({ id: undefined }), '12 example way', NOW)).toBeNull();
    expect(P.reusableCheck(move(), '14 example way', NOW)).toBeNull();
    expect(P.reusableCheck(move({ checked_at: '2026-11-01T14:00:00.000Z' }), '12 example way', NOW)).toBeNull();
    expect(P.reusableCheck(move({ providerAnswered: false }), '12 example way', NOW)).toBeNull();
    expect(P.reusableCheck({ last_check: null }, '12 example way', NOW)).toBeNull();
  });
});

describe('the office item words', () => {
  test('an address names the typed text, Google\'s version, the verdict, the dates and the plan', () => {
    const text = P.requestDescription({
      typed: '12 Example Way, Parrish',
      normalized: { line1: '12 Example Way', line2: null, city: 'Parrish', state: 'FL', zip: '34219' },
      verdict: 'in_area',
      moveOut: '2026-11-15',
      moveIn: null,
      services: ['Monthly Pest Control Service'],
    });
    expect(text).toContain('New address as typed: 12 Example Way, Parrish.');
    expect(text).toContain("Google's version: 12 Example Way, Parrish, FL 34219.");
    expect(text).toContain('inside our service area');
    expect(text).toContain('Move-out date: Nov 15, 2026.');
    expect(text).toContain('Move-in date: not known yet.');
    expect(text).toContain('Current plan: Monthly Pest Control Service.');
  });

  test('no address says so, and the subject names the city or "not known yet"', () => {
    const text = P.requestDescription({ typed: null, normalized: null, verdict: null, moveOut: '2026-11-15', moveIn: null, services: [] });
    expect(text).toContain('New address: not known yet.');
    expect(P.requestSubject(null, false)).toBe('Moving: address not known yet');
    expect(P.requestSubject({ city: 'Parrish' }, true)).toBe('Moving: Parrish');
  });

  test('the alert line names the area result', () => {
    expect(P.alertWhy({ city: 'Parrish' }, true, 'in_area')).toBe('New home in Parrish, in our area.');
    expect(P.alertWhy({ city: 'Ormond Beach' }, true, 'out_of_area')).toBe('New home in Ormond Beach, outside our area.');
    expect(P.alertWhy(null, false, null)).toBe('Moving soon, new address not known yet.');
  });
});

describe('the receipt sentences', () => {
  const view = (over) => ({ firstName: 'Chris', addressOnFile: true, verdict: 'in_area', ...over });

  test('in area', () => {
    expect(Moves.receiptFor(view())).toEqual([
      'Thanks, Chris. We have your move. We will price your new home and send it to you to review. Nothing changes until you approve it.',
    ]);
  });

  test('out of area', () => {
    expect(Moves.receiptFor(view({ verdict: 'out_of_area' }))).toEqual([
      'Thanks, Chris. We do not serve that address yet. We will contact you about your last visit and ending your plan on your move-out date.',
    ]);
  });

  test('dates only', () => {
    expect(Moves.receiptFor(view({ addressOnFile: false, verdict: null }))).toEqual([
      'Thanks, Chris. We have your move dates. When you know your new address, open this same link and add it.',
    ]);
  });

  test('unverified adds the check-with-you sentence', () => {
    expect(Moves.receiptFor(view({ verdict: 'unverified' }))).toEqual([
      'Thanks, Chris. We have your move. We will price your new home and send it to you to review. Nothing changes until you approve it.',
      'We could not confirm that address, so we will check it with you.',
    ]);
  });

  // Moving PR 2b (GATE_MOVING_PAUSE, owner Q4): the no-address receipt names the pause,
  // which needs a move-out date to start from.
  test('dates only, with the move pause on: the receipt names the pause and its 60 days', () => {
    const saved = { flow: process.env.GATE_MOVING_FLOW, pause: process.env.GATE_MOVING_PAUSE };
    process.env.GATE_MOVING_FLOW = 'true';
    process.env.GATE_MOVING_PAUSE = 'true';
    try {
      expect(Moves.receiptFor(view({ addressOnFile: false, verdict: null, moveOutDate: '2026-11-20' }))).toEqual([
        'Thanks, Chris. We have your move dates. We pause your visits after Nov 20, 2026 until we have your new address, for up to 60 days. When you know it, open this same link and add it.',
      ]);
      expect(Moves.receiptFor(view({ addressOnFile: false, verdict: null, moveOutDate: null }))).toEqual([
        'Thanks, Chris. We have your move dates. When you know your new address, open this same link and add it.',
      ]);
      process.env.GATE_MOVING_PAUSE = 'false';
      expect(Moves.receiptFor(view({ addressOnFile: false, verdict: null, moveOutDate: '2026-11-20' }))).toEqual([
        'Thanks, Chris. We have your move dates. When you know your new address, open this same link and add it.',
      ]);
    } finally {
      for (const [key, value] of [['GATE_MOVING_FLOW', saved.flow], ['GATE_MOVING_PAUSE', saved.pause]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test('no receipt sentence carries a dollar sign', () => {
    for (const v of [view(), view({ verdict: 'out_of_area' }), view({ addressOnFile: false }), view({ verdict: 'unverified' })]) {
      expect(Moves.receiptFor(v).join(' ')).not.toMatch(/\$/);
    }
  });
});

describe('one verdict rule for the cancel flow and the moving page', () => {
  test('accepted in-area, accepted out-of-area, and anything partial', () => {
    expect(cancelMoveAddressVerdict({ status: STATUSES.VALIDATED_ACCEPT, inServiceArea: true }, STATUSES)).toBe(true);
    expect(cancelMoveAddressVerdict({ status: STATUSES.CORRECTED, inServiceArea: true }, STATUSES)).toBe(true);
    expect(cancelMoveAddressVerdict({ status: STATUSES.OUT_OF_SERVICE_AREA }, STATUSES)).toBe(false);
    expect(cancelMoveAddressVerdict({ status: STATUSES.VALIDATED_ACCEPT, inServiceArea: false }, STATUSES)).toBeNull();
    expect(cancelMoveAddressVerdict(null, STATUSES)).toBeNull();
    expect(moveVerdictLabel({ status: STATUSES.VALIDATED_ACCEPT, inServiceArea: true }, STATUSES)).toBe('in_area');
    expect(moveVerdictLabel({ status: STATUSES.OUT_OF_SERVICE_AREA }, STATUSES)).toBe('out_of_area');
    expect(moveVerdictLabel({ status: STATUSES.API_UNAVAILABLE }, STATUSES)).toBe('unverified');
  });
});

describe('the move alert and the admin bell policy', () => {
  const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
  const { bellAllowed } = require('../services/notification-bell-policy');
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  async function composedMoveAlert() {
    raiseAdminAlert.mockClear();
    await P.raiseMoveAlert({
      move: { id: 'move-1', customer_id: '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f' },
      customer: { first_name: 'Pat', last_name: 'Example' },
      request: { id: 'req-1', subject: 'Moving: Parrish' },
      normalized: { city: 'Parrish' },
      hasAddress: true,
      verdict: 'in_area',
      description: 'New address as typed: 12 Example Way, Parrish.',
    });
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    return { category, spec, opts, composed: composeAdminAlert(spec) };
  }

  test('a declared customer contact rings with GATE_ADMIN_BELL_POLICY and GATE_CUSTOMER_ALERTS_RING on', async () => {
    process.env.GATE_ADMIN_BELL_POLICY = 'true';
    process.env.GATE_CUSTOMER_ALERTS_RING = 'true';
    const { category, opts, composed } = await composedMoveAlert();
    expect(category).toBe('service');
    expect(composed.metadata.contact).toBe(true);
    const declared = { contact: composed.metadata.contact === true, promise: composed.metadata.promise === true };
    expect(await bellAllowed({ category, options: opts, declared })).toBe(true);
    // The same alert without the declaration is silenced by the policy.
    expect(await bellAllowed({ category, options: opts, declared: { contact: false, promise: false } })).toBe(false);
  });
});

test('the token shape is 48 hex characters', () => {
  expect(Moves.TOKEN_RE.test('a'.repeat(48))).toBe(true);
  expect(Moves.TOKEN_RE.test('a'.repeat(64))).toBe(false);
  expect(Moves.TOKEN_RE.test('g'.repeat(48))).toBe(false);
});

describe('the new-home estimate stamps (moving PR B1)', () => {
  const move = {
    id: 'move-1',
    move_out_date: new Date('2026-11-20T00:00:00Z'),
    move_in_date: '2026-11-25',
    normalized_address: { line1: '40 Sample Road', line2: null, city: 'Venice', state: 'FL', zip: '34285' },
  };

  test('the waiver keeps a stored discount and always waives the setup fee', () => {
    expect(Moves.withMoveSetupWaiver(null)).toEqual({
      type: null, value: 0, label: null,
      internalReason: expect.stringMatching(/moving.*\$99 setup fee is waived/i),
      floorBreachAcknowledged: false, waiveSetupFee: true,
    });
    expect(Moves.withMoveSetupWaiver({ type: 'PERCENT', value: 10, label: 'Neighbor', internalReason: 'Office', waiveSetupFee: false })).toEqual({
      type: 'PERCENT', value: 10, label: 'Neighbor', internalReason: 'Office', floorBreachAcknowledged: false, waiveSetupFee: true,
    });
    expect(Moves.withMoveSetupWaiver(['not', 'an', 'object']).waiveSetupFee).toBe(true);
  });

  test('the move stamp carries calendar dates, never a time-zone-shifted day', () => {
    expect(Moves.moveEstimateStamp(move)).toEqual({
      moveId: 'move-1', address: '40 Sample Road, Venice, FL 34285', moveOutDate: '2026-11-20', moveInDate: '2026-11-25',
    });
    expect(Moves.moveEstimateStamp({ id: 'm', move_out_date: null, move_in_date: null }))
      .toEqual({ moveId: 'm', address: '', moveOutDate: null, moveInDate: null });
  });

  test('only the move\'s new street, in its city or ZIP, matches', () => {
    expect(Moves.addressMatchesMove('40 Sample Road, Venice, FL 34285', move)).toBe(true);
    expect(Moves.addressMatchesMove('40 Sample Rd, Venice, FL 34285', move)).toBe(true);
    expect(Moves.addressMatchesMove('40 Sample Road, Venice FL', move)).toBe(true);
    expect(Moves.addressMatchesMove('41 Sample Road, Venice, FL 34285', move)).toBe(false);
    expect(Moves.addressMatchesMove('40 Sample Road, Bradenton, FL 34205', move)).toBe(false);
    expect(Moves.addressMatchesMove('40 Sample Road', move)).toBe(false);
    expect(Moves.addressMatchesMove('', move)).toBe(false);
    expect(Moves.addressMatchesMove('40 Sample Road, Venice, FL 34285', { normalized_address: null })).toBe(false);
  });
});
